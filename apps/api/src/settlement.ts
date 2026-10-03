/**
 * Settlement driver (DEVNET ONLY) — runs unattended, no admin, no AI.
 *
 * State machine (identical to programs/roulette):
 *   OPEN            → nothing; the program flips OPEN→FULL at exactly the cap
 *   FULL            → lock_round        (commits reveal slot, freezes fee_bps)
 *   RANDOMNESS_PENDING, winner not frozen, slot ≥ reveal_slot
 *                   → settle_round      (phase 1: freeze randomness/winner/amounts)
 *   RANDOMNESS_PENDING, winner frozen
 *                   → pay_winners       (phase 2: 98% + 2%, → COMPLETED)
 *   COMPLETED       → create next round in this lane
 *
 * One tick per pool lane (0=1 SOL, 1=10 SOL, 2=100 SOL) so a settling 1-SOL
 * round never blocks the other lanes. Round ids come from the shared counter
 * (`counter + 1`), so lanes never collide.
 *
 * Payout idempotence: the round's own status is the primary guard (a paid round
 * is COMPLETED and can never be paid again); the tx ledger is the secondary
 * guard and is written only AFTER confirmation.
 */
import { PublicKey } from "@solana/web3.js";
import type { RoundData } from "@solana-roulette/verification";
import type { AppConfig } from "@solana-roulette/config";
import { TIER_COUNT, isTerminalState } from "@solana-roulette/types";
import type { ChainBackend, LifecycleResult } from "./backend.js";
import { requireFeeWallet } from "./operator.js";
import { store, broadcast } from "./store.js";
import { txLog } from "./logger.js";
import { createDriverLease, type DriverLease } from "./settlementLease.js";
import type { PayoutOutcome, PayoutService } from "./payout.js";

export interface SettlementDriverDeps {
  backend: ChainBackend;
  cfg: AppConfig;
  /**
   * Real devnet payout service. When present, a frozen winner is paid with a
   * REAL on-chain transfer and the round only completes once that transfer is
   * CONFIRMED. Absent (tests, or when the Anchor program itself pays) the
   * driver keeps the program-paid path.
   */
  payouts?: PayoutService;
  /**
   * Cross-instance single-writer guard. Defaults to a Postgres advisory-lock
   * lease keyed by the program id (see settlementLease.ts); tests inject a fake
   * to prove only one of two drivers ever advances a lane.
   */
  lease?: DriverLease;
}

let started = false;

/**
 * Rehydrate the lane heads from the chain after a restart.
 *
 * `store.currentRoundIdByTier` is in-memory only and boots at [1, 2, 3]. In
 * chain mode a restart therefore used to leave every lane pointing at rounds
 * long completed: `advanceTierLane` read a terminal head, saw "nothing to
 * advance" and opened a DUPLICATE round via the shared counter — while the
 * real head of that lane never advanced again (orphaned round tracking, stale
 * `/api/pools`). This re-derives each lane's true head from on-chain round
 * accounts before the driver's first tick, mirroring how
 * `rehydrateCompletedRounds` repairs history at boot.
 *
 * A lane's head is its newest round with that lane's tier. Ids are globally
 * sequential, so the newest round of a quiet lane (e.g. the 100-SOL one) can
 * sit arbitrarily far below the global counter; the scan therefore walks ONE
 * newest-first window from the counter down (capped at LANE_SCAN_LIMIT ids,
 * which spans every lane as long as the quietest lane created a round within
 * the window) and picks the newest id per tier. Reads are batched in chain
 * mode via `backend.getRounds` (one or two `getMultipleAccountsInfo` calls),
 * never one RPC per id.
 *
 * Best-effort, like every boot repair: never throws. A partial or failed
 * rehydration leaves the affected lane at its boot default — exactly the
 * pre-fix behaviour — and the driver re-seeds it from the chain on later
 * ticks. `LANE_HEAD_REHYDRATE_MS` can force a periodic re-check.
 */
export const LANE_SCAN_LIMIT = 200;
/** Hard cap on chained scan windows (LANE_SCAN_LIMIT ids each). */
export const MAX_SCAN_WINDOWS = 10;

export async function rehydrateLaneHeads(deps: SettlementDriverDeps): Promise<{
  heads: bigint[];
  restored: number;
  counter: bigint | null;
}> {
  const { backend } = deps;
  const tierCount = store.currentRoundIdByTier.length;

  // One counter read bounds the scan from above; a missing config is not
  // fatal — the scan simply starts lower (max boot default) and stays capped.
  let counter: bigint | null = null;
  try {
    const cfg = await backend.getGlobalConfig();
    if (cfg) counter = cfg.roundCounter;
  } catch {
    /* counter stays null — the scan proceeds with the boot defaults */
  }

  const highest = counter ?? BigInt(tierCount);

  // Head = newest id whose round exists AND whose tier matches the lane. The
  // tier check is what makes a round created for the wrong lane (the pre-fix
  // duplicate) unable to poison the lane it landed in.
  const perTier = new Map<number, bigint>();
  const missing = () => Array.from({ length: tierCount }, (_, t) => t).filter((t) => !perTier.has(t));

  // Newest-first windows of LANE_SCAN_LIMIT ids. A quiet lane's newest round
  // can sit arbitrarily far below the counter (e.g. the 100-SOL lane behind a
  // busy 1-SOL lane), so windows CHAIN downward until every lane has a head —
  // bounded by MAX_SCAN_WINDOWS to keep a pathological chain from scanning
  // forever. One window is the common case (one batched RPC read).
  let scanned = 0n;
  for (let windowIdx = 0; windowIdx < MAX_SCAN_WINDOWS; windowIdx++) {
    const top = windowIdx === 0 ? highest : highest - scanned;
    if (top < 1n) break;
    const bottom = top - BigInt(LANE_SCAN_LIMIT) > 1n ? top - BigInt(LANE_SCAN_LIMIT) : 1n;

    const ids: bigint[] = [];
    for (let id = top; id >= bottom; id--) ids.push(id);

    let rounds = new Map<string, RoundData>();
    try {
      if (backend.getRounds) {
        rounds = await backend.getRounds(ids);
      } else {
        for (const id of ids) {
          const r = await backend.getRound(id);
          if (r) rounds.set(id.toString(), r);
        }
      }
    } catch (err) {
      txLog.warn("settlement.head_rehydrate_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { heads: [...store.currentRoundIdByTier], restored: 0, counter };
    }

    for (const id of ids) {
      const round = rounds.get(id.toString());
      if (!round) continue;
      // A pre-`reveal_input` account is readable but NOT usable by the deployed
      // program (every instruction reverts with AccountDidNotDeserialize).
      // Adopting one as a lane head pins the lane to an unusable account, so it
      // is skipped here; the driver opens a fresh round for that lane instead.
      if (round.legacy) continue;
      if (!perTier.has(round.tier)) perTier.set(round.tier, id);
    }
    scanned += top - bottom + 1n;
    if (missing().length === 0) break;
  }

  let restored = 0;
  for (let tier = 0; tier < tierCount; tier++) {
    const found = perTier.get(tier);
    if (found === undefined) continue;
    if (store.setLaneHead(tier, found)) restored++;
  }

  txLog.info("settlement.heads_rehydrated", {
    heads: store.currentRoundIdByTier.map((h) => h.toString()),
    restored,
    counter: counter?.toString() ?? null,
  });
  return { heads: [...store.currentRoundIdByTier], restored, counter };
}

/**
 * Re-entrancy guard around one settlement pass.
 *
 * The driver is an unattended interval, and a pass is not instantaneous: it
 * reads three lanes from the RPC, waits for a reveal slot, and in the real-funds
 * path broadcasts and confirms a payout. If a pass outlives the poll interval
 * the next one starts while the first is still running, and two passes racing
 * over the same lane can each open a "next round" (two OPEN rounds in one lane,
 * the older one and its pot orphaned) or each start the same payout. The guard
 * makes a pass strictly serial: an overlapping tick is dropped, not queued —
 * the next interval re-reads the chain and continues from there.
 *
 * Returns whether the pass actually ran.
 */
export function createGuardedTick(
  deps: SettlementDriverDeps,
  pass: (d: SettlementDriverDeps) => Promise<void> = runOnce
): () => Promise<boolean> {
  let inFlight = false;
  return async function tick(): Promise<boolean> {
    if (inFlight) return false;
    inFlight = true;
    try {
      await pass(deps);
      return true;
    } finally {
      inFlight = false;
    }
  };
}

/** Result of a leader-gated tick ("busy" = a pass is already in flight). */
export type LeaderTickOutcome = "ran" | "busy" | "standby";

/**
 * Run a driver tick ONLY while this instance holds the lease. `createGuardedTick`
 * already serializes passes inside one process; this adds the cross-instance
 * gate that stops a second deployment from advancing the same program's lanes.
 */
export async function runLeaderTick(
  lease: DriverLease,
  tick: () => Promise<boolean>
): Promise<LeaderTickOutcome> {
  if (!(await lease.acquire())) return "standby";
  return (await tick()) ? "ran" : "busy";
}

export function startSettlementDriver(deps: SettlementDriverDeps): void {
  if (started) return;

  // Explicit kill switch: a deployment that must NOT drive settlement (for
  // example a second environment sharing one program) sets SETTLEMENT_DRIVER=off
  // and never ticks, regardless of the lease backend.
  if ((process.env.SETTLEMENT_DRIVER ?? "auto").trim().toLowerCase() === "off") {
    txLog.warn("settlement.disabled", {
      reason: "SETTLEMENT_DRIVER=off",
      programId: deps.cfg.programId,
    });
    return;
  }
  started = true;

  const intervalMs = Number(process.env.SETTLEMENT_POLL_MS ?? 5_000);
  const tick = createGuardedTick(deps);
  const lease =
    deps.lease ??
    createDriverLease({
      databaseUrl: process.env.DATABASE_URL,
      programId: deps.cfg.programId,
      network: deps.cfg.network,
      mode: deps.backend.mode,
    });

  // Log leadership transitions once each, so an operator can see which instance
  // drives. The lease is re-contended every tick, so a crashed leader's peer
  // takes over on its next pass.
  let standbyLogged = false;
  const safeTick = async () => {
    try {
      const outcome = await runLeaderTick(lease, tick);
      if (lease.kind === "postgres") {
        if (outcome === "standby" && !standbyLogged) {
          standbyLogged = true;
          txLog.warn("settlement.standby", {
            reason: "another instance holds the settlement-driver lease",
            lease: lease.kind,
            programId: deps.cfg.programId,
            network: deps.cfg.network,
          });
        } else if (outcome === "ran" && standbyLogged) {
          standbyLogged = false;
          txLog.info("settlement.leader_acquired", {
            programId: deps.cfg.programId,
            network: deps.cfg.network,
          });
        }
      }
    } catch (e) {
      console.warn("[settlement]", e instanceof Error ? e.message : e);
    }
  };

  // Periodic head re-check. Lane heads are derived from on-chain state now,
  // but the driver's own writes and any process-lifetime drift can leave the
  // array stale; a slow re-scan keeps it honest and also heals a lane whose
  // boot-time rehydration failed (RPC hiccup). Cheap: one batched read.
  const recheckMs = Number(process.env.LANE_HEAD_REHYDRATE_MS ?? 120_000);
  if (recheckMs > 0) {
    const recheck = setInterval(() => {
      void rehydrateLaneHeads(deps).catch((e: unknown) => {
        txLog.warn("settlement.head_rehydrate_failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      });
    }, recheckMs);
    recheck.unref();
  }

  setInterval(safeTick, intervalMs).unref();
  void safeTick();
}

export async function runOnce(deps: SettlementDriverDeps): Promise<void> {
  const { cfg } = deps;

  // Fail-safe gate: missing/invalid fee wallet disables the financial loop.
  try {
    requireFeeWallet(cfg);
  } catch (err) {
    console.warn(
      "[settlement] financial flow disabled:",
      err instanceof Error ? err.message : err
    );
    return;
  }

  for (let tier = 0; tier < TIER_COUNT; tier++) {
    try {
      await advanceTierLane(tier, deps);
    } catch (e) {
      console.warn(`[settlement] tier ${tier}:`, e instanceof Error ? e.message : e);
    }
  }
}

/** Advance one tier's lane by exactly one state-machine step. */
export async function advanceTierLane(tier: number, deps: SettlementDriverDeps): Promise<void> {
  const { backend } = deps;
  const heads = await backend.getHeadByTier();
  const head = heads[tier] && heads[tier]! > 0n ? heads[tier]! : BigInt(tier + 1);
  const round = await backend.getRound(head);

  // A legacy (pre-`reveal_input`) head is not a usable round at all: the
  // deployed program cannot deserialize it, so deposit/lock/settle all revert
  // with AnchorError 3003. This is the "can't join this pool" failure — the
  // quiet lanes were pinned to genesis rounds 2 and 3. Abandon it and open a
  // fresh, current-layout round in this lane.
  if (round?.legacy) {
    await openNextRound(tier, deps, round.id);
    return;
  }

  // Lane discipline BEFORE the terminal check: a stale head can point at
  // another tier's round (the pre-rehydration duplicate), and opening a
  // "next" round for THIS lane while looking at a COMPLETED round of another
  // lane is exactly the duplicate-creation bug. Re-scan the chain and adopt
  // the newest round of this lane; nothing opens until the lane is sure.
  if (round && round.tier !== tier) {
    await rehydrateLaneHeads(deps);
    return;
  }
  if (!round || isTerminalState(round.status)) {
    await openNextRound(tier, deps, round?.id);
    return;
  }
  store.setLaneHead(tier, round.id);
  const roundId = round.id;

  switch (round.status) {
    case "OPEN": {
      // The pool cap is enforced by the runtime; a round only leaves OPEN by
      // hitting exactly the tier cap. In a quiet lane that may NEVER happen, and
      // because a wallet may only enter a round once, every participant would be
      // permanently locked out of the lane (the `already_deposited` trap).
      //
      // Safety valve: once a funded OPEN round has been observed OPEN for longer
      // than `ROUND_TIMEOUT_MS`, the driver cancels it (operator-signed
      // `cancel_round`, which refunds every participant EXACTLY on chain) and
      // reopens the lane, so deposits can proceed again. A round that is still
      // filling normally (fresh observer) is never touched.
      const timeoutMs = roundTimeoutMs();
      if (timeoutMs > 0 && round.pot > 0n) {
        const seenAt = store.markOpenSeen(roundId);
        if (Date.now() - seenAt >= timeoutMs) {
          await resetStaleOpenRound(tier, deps, roundId, seenAt);
        }
      }
      break;
    }
    case "FULL": {
      const sent = await backend.runLifecycle("lock", { roundId });
      if (sent) {
        broadcast({ type: "lock", roundId: roundId.toString(), data: { tier } });
        broadcast({ type: "round_full", roundId: roundId.toString(), data: { tier } });
        store.upsertRound({ id: roundId.toString(), tier, status: "RANDOMNESS_PENDING", feeBps: round.feeBps });
      }
      break;
    }
    case "RANDOMNESS_PENDING": {
      const winnerFrozen = !!round.winner && !round.winner.equals(PublicKey.default);

      if (!winnerFrozen) {
        const slot = await backend.getCurrentSlot();
        if (slot < round.revealSlot) break; // reveal slot not reached — wait
        const settled = await backend.runLifecycle("settle", { roundId });
        if (settled) {
          broadcast({
            type: "randomness_arrived",
            roundId: roundId.toString(),
            data: { tier, revealSlot: round.revealSlot.toString() },
          });
        }
        break;
      }

      // Winner frozen → pay out (phase 2).
      if (store.hasPayout(roundId.toString())) break; // secondary idempotence guard

      // REAL funds path: the winner is paid with an actual devnet transfer and
      // the round stays open until that transfer is CONFIRMED on chain.
      if (deps.payouts) {
        const outcome = await deps.payouts.ensureRoundPaid({
          roundId,
          tier: round.tier,
          winner: round.winner.toBase58(),
        });
        if (outcome.status !== "CONFIRMED") {
          // PENDING (submitted, waiting) / FAILED (retry with backoff) /
          // SKIPPED (custody not configured): never complete, never advance.
          txLog.warn("settlement.payout_not_confirmed", {
            roundId: roundId.toString(),
            tier: round.tier,
            winner: round.winner.toBase58(),
            status: outcome.status,
            reason: outcome.reason,
          });
          break;
        }
        await completePaidRound(tier, deps, roundId, {
          signature: outcome.signature,
          winner: outcome.winner,
          payoutLamports: outcome.payoutLamports,
          feeLamports: outcome.feeLamports,
          alreadyPaid: outcome.alreadyPaid,
        });
        return;
      }

      const sent = await backend.runLifecycle("pay", { roundId });
      if (sent) {
        // Program-paid path: the program moved the lamports and the signature
        // is already confirmed before this point (verify-first principle).
        store.markPayout(roundId.toString());
        broadcast({
          type: "winner",
          roundId: roundId.toString(),
          data: { tier, winner: sent.winner, payoutLamports: sent.payoutLamports, feeLamports: sent.feeLamports },
        });
        broadcast({
          type: "settlement",
          roundId: roundId.toString(),
          data: {
            tier,
            signature: sent.signature,
            payoutTx: sent.signature,
            explorer: `https://explorer.solana.com/tx/${sent.signature}?cluster=devnet`,
          },
        });
        store.upsertRound({
          id: roundId.toString(),
          tier,
          status: "COMPLETED",
          feeBps: round.feeBps,
          winner: sent.winner ?? null,
          payoutTxSignature: sent.signature,
          settlementVerified: true,
          completedAt: new Date(),
        });
        await openNextRound(tier, deps, roundId);
      }
      break;
    }
    default:
      break; // LOCKED/SETTLING are DTO aliases; the runtime never reports them
  }
}

/**
 * Mark a round COMPLETED and open the next one. Reached only after the payout
 * transfer is CONFIRMED on chain — the chain decides, never the database.
 */
async function completePaidRound(
  tier: number,
  deps: SettlementDriverDeps,
  roundId: bigint,
  paid: {
    signature: string;
    winner: string;
    payoutLamports: bigint;
    feeLamports: bigint;
    alreadyPaid: boolean;
  }
): Promise<void> {
  const { backend } = deps;
  // Flip the runtime state only now that the money has actually moved.
  await backend.runLifecycle("pay", { roundId });
  store.markPayout(roundId.toString());
  broadcast({
    type: "winner",
    roundId: roundId.toString(),
    data: {
      tier,
      winner: paid.winner,
      payoutLamports: paid.payoutLamports.toString(),
      feeLamports: paid.feeLamports.toString(),
    },
  });
  broadcast({
    type: "settlement",
    roundId: roundId.toString(),
    data: {
      tier,
      signature: paid.signature,
      payoutTx: paid.signature,
      explorer: `https://explorer.solana.com/tx/${paid.signature}?cluster=devnet`,
    },
  });  store.upsertRound({
          id: roundId.toString(),
          tier,
          status: "COMPLETED",
          feeBps: deps.cfg.feeBps,
    winner: paid.winner,
    payoutTxSignature: paid.signature,
    settlementVerified: true,
    completedAt: new Date(),
  });
  if (!paid.alreadyPaid) {
    txLog.info("settlement.payout_confirmed", {
      roundId: roundId.toString(),
      tier,
      winner: paid.winner,
      payoutLamports: paid.payoutLamports.toString(),
      feeLamports: paid.feeLamports.toString(),
      signature: paid.signature,
      status: "CONFIRMED",
    });
  }
  await openNextRound(tier, deps, roundId);
}
/** Create the next round for this lane; the id always comes from the counter. */
async function openNextRound(
  tier: number,
  deps: SettlementDriverDeps,
  previousId?: bigint
): Promise<LifecycleResult | null> {
  const { backend, cfg } = deps;
  // No explicit id: the runtime allocates `counter + 1`, which is what the
  // program enforces. Deriving `previousId + 1` would collide across lanes.
  const created = await backend.runLifecycle("create", { tier });
  if (!created) return null;
  store.currentRoundIdByTier[tier] = created.roundId;
  store.clearOpenSeen(previousId ?? 0n);
  broadcast({ type: "new_round", roundId: created.roundId.toString(), data: { tier, previous: previousId?.toString() } });
  store.upsertRound({ id: created.roundId.toString(), tier, status: "OPEN", feeBps: cfg.feeBps });
  return created;
}

/**
 * How long a funded OPEN round may wait for its cap before the driver refunds
 * it and reopens the lane. `ROUND_TIMEOUT_MS` is in milliseconds; `0` disables
 * the safety valve entirely (rounds then only ever close at their cap). Values
 * below `MIN_ROUND_TIMEOUT_MS` are clamped so a typo cannot cancel healthy
 * rounds immediately.
 */
export const MIN_ROUND_TIMEOUT_MS = 60_000;
export const DEFAULT_ROUND_TIMEOUT_MS = 900_000;
export function roundTimeoutMs(): number {
  const raw = process.env.ROUND_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_ROUND_TIMEOUT_MS;
  const n = Number(raw);
  // A malformed value keeps the safety valve ON rather than silently disabling
  // it (which would re-introduce the frozen-lane bug). Only an explicit 0 — or
  // a negative number — turns it off.
  if (!Number.isFinite(n)) return DEFAULT_ROUND_TIMEOUT_MS;
  if (n <= 0) return 0;
  return Math.max(Math.round(n), MIN_ROUND_TIMEOUT_MS);
}

/**
 * Cancel a stale OPEN round and reopen its lane.
 *
 * `cancel_round` is operator-only on chain and refunds EXACTLY each recorded
 * participant deposit (the program walks the full index-ordered participant
 * list and requires the refunded total to equal the pot), so no lamport is
 * created, lost or stranded. Only then is the next round opened, which is what
 * lets a wallet deposit again. Idempotent by construction: after the cancel the
 * head points at the freshly created round, so the old id is never revisited.
 */
async function resetStaleOpenRound(
  tier: number,
  deps: SettlementDriverDeps,
  roundId: bigint,
  seenAt: number
): Promise<void> {
  const { backend } = deps;
  const cancelled = await backend.runLifecycle("cancel", { roundId });
  if (!cancelled) {
    // A failed cancel (RPC hiccup, program rejection) must not retry on every
    // tick: re-arm the clock so the next attempt waits another full timeout.
    store.clearOpenSeen(roundId);
    txLog.warn("settlement.stale_round_cancel_failed", {
      roundId: roundId.toString(),
      tier,
      network: deps.cfg.network,
    });
    return;
  }
  store.clearOpenSeen(roundId);
  store.upsertRound({ id: roundId.toString(), tier, status: "CANCELLED" });
  // The program refunded every participant exactly on chain, so the round's
  // CONFIRMED ledger rows must stop counting as entries (and as pot): they are
  // orphaned, exactly as the deposit gate does for a phantom row.
  const orphaned = store.txs.orphanConfirmedDepositsOfRound(
    roundId,
    `round ${roundId} was cancelled; participants refunded on chain`
  );
  broadcast({
    type: "settlement",
    roundId: roundId.toString(),
    data: { tier, reason: "stale_round_cancelled", openMs: Date.now() - seenAt },
  });
  txLog.warn("settlement.stale_round_cancelled", {
    roundId: roundId.toString(),
    tier,
    openMs: Date.now() - seenAt,
    signature: cancelled.signature,
    orphanedEntries: orphaned,
    network: deps.cfg.network,
  });
  await openNextRound(tier, deps, roundId);
}

/**
 * Operator action: reset a lane's CURRENT round now, without waiting for the
 * timeout. Cancels the lane's OPEN round (refunding its participants on chain)
 * and opens a fresh one. Never touches a round that is already settling.
 */
export async function advanceLaneManually(
  tier: number,
  deps: SettlementDriverDeps
): Promise<{
  roundId: string | null;
  status: string | null;
  potLamports: string;
  cancelled: boolean;
  cancelSignature: string | null;
  newRoundId: string | null;
  detail: string;
}> {
  const heads = await deps.backend.getHeadByTier();
  const head = heads[tier] && heads[tier]! > 0n ? heads[tier]! : BigInt(tier + 1);
  const round = await deps.backend.getRound(head);

  const open = async (previousId?: bigint) => {
    const created = await openNextRound(tier, deps, previousId);
    return { newRoundId: created?.roundId.toString() ?? null };
  };

  if (!round || round.legacy) {
    // A legacy head cannot be cancelled (the program cannot even deserialize
    // it), so it is simply abandoned and a fresh current-layout round opened.
    const { newRoundId } = await open(round?.id);
    return {
      roundId: round ? round.id.toString() : null,
      status: round ? round.status : null,
      potLamports: round ? round.pot.toString() : "0",
      cancelled: false,
      cancelSignature: null,
      newRoundId,
      detail: round?.legacy
        ? `lane head #${round.id} predates the program layout; opened #${newRoundId ?? "?"}`
        : newRoundId
          ? `lane had no round; opened #${newRoundId}`
          : "lane had no round and a fresh one could not be opened",
    };
  }

  if (round.status !== "OPEN") {
    return {
      roundId: round.id.toString(),
      status: round.status,
      potLamports: round.pot.toString(),
      cancelled: false,
      cancelSignature: null,
      newRoundId: null,
      detail: `lane round #${round.id} is ${round.status}; only an OPEN round can be reset`,
    };
  }

  let cancelled = false;
  let cancelSignature: string | null = null;
  if (round.pot > 0n) {
    const result = await deps.backend.runLifecycle("cancel", { roundId: round.id });
    if (!result) {
      return {
        roundId: round.id.toString(),
        status: round.status,
        potLamports: round.pot.toString(),
        cancelled: false,
        cancelSignature: null,
        newRoundId: null,
        detail: `cancel of round #${round.id} failed; nothing was changed`,
      };
    }
    cancelled = true;
    cancelSignature = result.signature;
    store.clearOpenSeen(round.id);
    store.upsertRound({ id: round.id.toString(), tier, status: "CANCELLED" });
    // Refunded on chain → the round's CONFIRMED ledger rows are no longer entries.
    const orphaned = store.txs.orphanConfirmedDepositsOfRound(
      round.id,
      `round ${round.id} was reset by an operator; participants refunded on chain`
    );
    broadcast({
      type: "settlement",
      roundId: round.id.toString(),
      data: { tier, reason: "manual_lane_reset" },
    });
    txLog.warn("settlement.lane_reset_manual", {
      roundId: round.id.toString(),
      tier,
      potLamports: round.pot.toString(),
      signature: result.signature,
      orphanedEntries: orphaned,
      network: deps.cfg.network,
    });
  }

  const { newRoundId } = await open(round.id);
  return {
    roundId: round.id.toString(),
    status: round.status,
    potLamports: round.pot.toString(),
    cancelled,
    cancelSignature,
    newRoundId,
    detail: cancelled
      ? `refunded round #${round.id} and opened #${newRoundId ?? "?"}`
      : `round #${round.id} was empty; opened #${newRoundId ?? "?"}`,
  };
}

/**
 * POOL_TARGET_SOL in lamports (already exact bigint from config; falls back to
 * max round size). Legacy single-pool knob — the tier caps are the
 * authoritative limits.
 */
export function poolTargetLamports(cfg: AppConfig): bigint {
  return cfg.poolTargetLamports ?? cfg.maxRoundSizeLamports;
}

/** Pool-volume cap of a tier in lamports (integer bigint math, no floats). */
export function tierCapLamports(cfg: AppConfig, tier: number): bigint {
  return cfg.tierCapsLamports[tier] ?? cfg.maxRoundSizeLamports;
}
