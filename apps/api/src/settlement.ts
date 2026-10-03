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
 * Last time the stalled-round sweep ran from `runOnce` (epoch ms).
 *
 * Initialised at module load, so the FIRST driver tick does not sweep: the
 * sweep waits one full `STALLED_SWEEP_MS` after boot and then runs on its own
 * cadence. Tests that want to exercise the sweep call `sweepStalledRounds`
 * directly (or re-arm this clock with `resetStalledSweepClockForTests`).
 */
let lastStalledSweepAt = Date.now();

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

  // Stalled-round sweep (see sweepStalledRounds). A round that left its lane's
  // head — locked, then overtaken by the lane, or orphaned by a restart — is
  // invisible to the per-lane loop above and would sit in RANDOMNESS_PENDING
  // forever, holding its pot in escrow. This finishes it too. Throttled so the
  // extra scan (one batched read of a bounded id window) does not run on every
  // 5 s tick; `STALLED_SWEEP_MS=0` disables the automatic sweep.
  const sweepMs = stalledSweepIntervalMs();
  if (sweepMs > 0 && Date.now() - lastStalledSweepAt >= sweepMs) {
    lastStalledSweepAt = Date.now();
    try {
      await sweepStalledRounds(deps);
    } catch (e) {
      console.warn("[settlement] sweep:", e instanceof Error ? e.message : e);
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
      // than `ROUND_TIMEOUT_MS`, the driver ends it (operator-signed
      // `cancel_round`, which refunds every participant EXACTLY on chain) and
      // reopens the lane, so deposits can proceed again. A round that is still
      // filling normally (fresh observer) is never touched.
      //
      // It is NOT silent any more: from `REFUND_WINDOW_LEAD_MS` before that
      // deadline the round enters a DECISION WINDOW. The players are asked —
      // "refund now, or keep waiting?" — and nothing is refunded until the
      // window closes with nobody choosing to wait. See refundWindowFor().
      const timeoutMs = roundTimeoutMs();
      if (timeoutMs > 0 && round.pot > 0n) {
        const seenAt = store.markOpenSeen(roundId);
        const decision = refundWindowFor(roundId, tier, deps, seenAt, timeoutMs);
        if (decision.status === "refund") {
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
      // Head path: finish the round (settle, then pay) and — because this IS
      // the lane head — open the lane's next round once the payout is
      // confirmed. The steps are shared with the stalled-round sweep via
      // advancePendingRound, so an orphaned round is finished exactly like a
      // head; only `openNextRound` differs (the sweep must not advance the lane).
      await advancePendingRound(tier, round, deps, { openNextRound: true });
      break;
    }
    default:
      break; // LOCKED/SETTLING are DTO aliases; the runtime never reports them
  }
}

/**
 * Outcome of advancing a RANDOMNESS_PENDING round one step.
 *
 *   waiting      — the reveal slot has not been reached yet
 *   settled      — phase 1 ran (winner/ticket/fee/payout frozen on chain)
 *   paid         — the winner was paid and the round is COMPLETED
 *   already-paid — a CONFIRMED payout already exists (no-op)
 *   deferred     — a payout was attempted but is not CONFIRMED yet (retry later)
 *   failed       — the on-chain instruction was rejected (logged, retried later)
 */
export type PendingOutcome =
  | "waiting"
  | "settled"
  | "paid"
  | "already-paid"
  | "deferred"
  | "failed";

/**
 * Advance ONE round that is currently RANDOMNESS_PENDING by one state-machine
 * step: settle it (phase 1) once the reveal slot is reached, then pay the
 * frozen winner (phase 2) and mark it COMPLETED. Idempotent — the round's own
 * on-chain status and the tx ledger guard every step, so calling it repeatedly
 * is a no-op.
 *
 * Shared by the lane-head path (`advanceTierLane`) and the stalled-round sweep
 * so an orphaned round is finished with EXACTLY the same steps as a head. The
 * only difference is `openNextRound`: a completed HEAD must advance its lane,
 * an ORPHAN must NOT (the lane already points past it — opening a round there
 * would create a duplicate nobody settles).
 *
 * This NEVER calls `cancel_round`: the program only allows cancel from
 * OPEN/FULL and cancel is operator-gated, so a stalled RANDOMNESS_PENDING round
 * can always be finished permissionlessly (settle + pay) but cannot be
 * cancelled — which is exactly what a vanished operator cannot block.
 * See docs/RANDOMNESS.md §2.3.
 */
async function advancePendingRound(
  tier: number,
  round: RoundData,
  deps: SettlementDriverDeps,
  opts: { openNextRound: boolean }
): Promise<PendingOutcome> {
  const { backend } = deps;
  const roundId = round.id;
  const winnerFrozen = !!round.winner && !round.winner.equals(PublicKey.default);

  if (!winnerFrozen) {
    const slot = await backend.getCurrentSlot();
    if (slot < round.revealSlot) return "waiting"; // reveal slot not reached
    const settled = await backend.runLifecycle("settle", { roundId });
    if (!settled) return "failed";
    broadcast({
      type: "randomness_arrived",
      roundId: roundId.toString(),
      data: { tier, revealSlot: round.revealSlot.toString() },
    });
    return "settled";
  }

  // Winner frozen → pay out (phase 2).
  if (store.hasPayout(roundId.toString())) return "already-paid"; // idempotence guard

  // REAL funds path: the winner is paid with an actual devnet transfer and the
  // round stays open until that transfer is CONFIRMED on chain.
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
      return "deferred";
    }
    await completePaidRound(
      tier,
      deps,
      roundId,
      {
        signature: outcome.signature,
        winner: outcome.winner,
        payoutLamports: outcome.payoutLamports,
        feeLamports: outcome.feeLamports,
        alreadyPaid: outcome.alreadyPaid,
      },
      opts.openNextRound
    );
    return "paid";
  }

  const sent = await backend.runLifecycle("pay", { roundId });
  if (!sent) return "failed";
  // Program-paid path: the program moved the lamports and the signature is
  // already verified before this point (backend.ts verifies every pay result).
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
  if (opts.openNextRound) await openNextRound(tier, deps, roundId);
  return "paid";
}

/**
 * How often the stalled-round sweep may run from `runOnce`, in ms.
 *
 * The sweep is one bounded extra read (a single batched window), so it runs
 * well below the tick rate. `0` disables the automatic sweep; the exported
 * `sweepStalledRounds` stays callable and testable either way.
 */
export const DEFAULT_STALLED_SWEEP_MS = 60_000;
export function stalledSweepIntervalMs(): number {
  const raw = process.env.STALLED_SWEEP_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_STALLED_SWEEP_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_STALLED_SWEEP_MS;
  return Math.round(n);
}

/**
 * How many round ids below the newest the sweep scans in one pass. Big enough
 * to span every lane's recent history (the quietest lane's newest round can sit
 * far below the global counter), small enough to remain one batched read.
 */
export const DEFAULT_STALLED_SWEEP_WINDOW = 200;
export function stalledSweepWindow(): number {
  const raw = process.env.STALLED_SWEEP_WINDOW;
  if (raw === undefined || raw.trim() === "") return DEFAULT_STALLED_SWEEP_WINDOW;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_STALLED_SWEEP_WINDOW;
  return Math.min(n, 2_000);
}

/** What one sweep pass did, for logs and tests. */
export interface StalledSweepReport {
  /** Round ids examined this pass. */
  scanned: number;
  /** Rounds that were RANDOMNESS_PENDING and not a lane head. */
  candidates: number;
  /** Phase 1 (settle) ran this pass. */
  settled: number;
  /** Phase 2 ran and the round is COMPLETED. */
  paid: number;
  /** Reveal slot not reached yet — nothing done. */
  waiting: number;
  /** Payout attempted but not yet CONFIRMED — retried next pass. */
  deferred: number;
  /** On-chain step rejected (e.g. reveal hash expired) — retried next pass. */
  failed: number;
  /** Ids skipped because they ARE a lane head (owned by advanceTierLane). */
  skippedHeads: number;
}

/**
 * Finish non-head rounds stalled in RANDOMNESS_PENDING.
 *
 * `advanceTierLane` only ever looks at a lane's HEAD. A round that was locked
 * and then overtaken (the lane moved on, or the driver restarted pointing at a
 * different round) is never visited again and sits in RANDOMNESS_PENDING
 * holding its pot in escrow — measured on devnet as rounds 24/25
 * (docs/DEVNET_LEGACY_STATE.md).
 *
 * This scans a bounded window of ids below the newest round, skips lane heads
 * (the normal loop owns those), and drives every remaining RANDOMNESS_PENDING
 * round through the SAME finish path as a head — settle once the reveal slot is
 * reached, then pay — but WITHOUT opening a new round for the lane.
 *
 * Safety properties, pinned by tests:
 *   - it only ever touches rounds whose on-chain status is exactly
 *     RANDOMNESS_PENDING — never OPEN/FULL/terminal, so it cannot interfere
 *     with an active or already-settled round;
 *   - it NEVER calls `cancel_round` (the program forbids cancel from
 *     RANDOMNESS_PENDING and cancel is operator-gated), so it can never cancel
 *     a healthy round;
 *   - every step is idempotent (status + tx ledger), so running concurrently
 *     with the head loop cannot double-settle or double-pay;
 *   - a read failure aborts the pass without touching anything.
 */
export async function sweepStalledRounds(
  deps: SettlementDriverDeps,
  opts: { window?: number } = {}
): Promise<StalledSweepReport> {
  const { backend } = deps;
  const report: StalledSweepReport = {
    scanned: 0,
    candidates: 0,
    settled: 0,
    paid: 0,
    waiting: 0,
    deferred: 0,
    failed: 0,
    skippedHeads: 0,
  };

  const heads = await backend.getHeadByTier();
  const headIds = new Set(heads.filter((h) => h > 0n).map((h) => h.toString()));

  // Upper bound: the newest id is the on-chain counter. Fall back to the
  // highest lane head so the sweep still works when the config is unreadable.
  let top = heads.reduce((m, h) => (h > m ? h : m), 0n);
  try {
    const cfg = await backend.getGlobalConfig();
    if (cfg?.roundCounter && cfg.roundCounter > top) top = cfg.roundCounter;
  } catch {
    /* keep the head-based bound */
  }

  const window = opts.window ?? stalledSweepWindow();
  const ids: bigint[] = [];
  for (let id = top; id >= 1n && ids.length < window; id--) {
    if (headIds.has(id.toString())) {
      report.skippedHeads++;
      continue;
    }
    ids.push(id);
  }
  if (ids.length === 0) return report;
  report.scanned = ids.length;

  let rounds: Map<string, RoundData>;
  try {
    if (backend.getRounds) {
      rounds = await backend.getRounds(ids);
    } else {
      rounds = new Map<string, RoundData>();
      for (const id of ids) {
        const r = await backend.getRound(id);
        if (r) rounds.set(id.toString(), r);
      }
    }
  } catch (err) {
    txLog.warn("settlement.sweep_read_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return report;
  }

  for (const id of ids) {
    const round = rounds.get(id.toString());
    if (!round || round.legacy) continue;
    if (round.status !== "RANDOMNESS_PENDING") continue;
    report.candidates++;
    try {
      const outcome = await advancePendingRound(round.tier, round, deps, {
        openNextRound: false,
      });
      switch (outcome) {
        case "settled":
          report.settled++;
          break;
        case "paid":
          report.paid++;
          break;
        case "waiting":
          report.waiting++;
          break;
        case "deferred":
          report.deferred++;
          break;
        case "failed":
          report.failed++;
          break;
        default:
          break; // already-paid: nothing left to do
      }
    } catch (err) {
      report.failed++;
      txLog.warn("settlement.sweep_round_failed", {
        roundId: id.toString(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (report.candidates > 0) {
    txLog.warn("settlement.sweep", { ...report, network: deps.cfg.network });
  }
  return report;
}

/** Test-only: re-arm the sweep throttle so a `runOnce` can be forced to sweep. */
export function resetStalledSweepClockForTests(): void {
  lastStalledSweepAt = 0;
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
  },
  /**
   * Open the lane's next round after completing. The lane-head path passes
   * `true`; the stalled-round sweep passes `false`, because it finishes an
   * ORPHAN round whose lane already points past it — opening a round there
   * would create a duplicate nobody settles.
   */
  openNext = true
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
  if (openNext) await openNextRound(tier, deps, roundId);
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
  store.clearRefundWindow(previousId ?? 0n);
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
 *
 * Default: 30 minutes — how long a player waits before their SOL is returned
 * automatically. (It was 15 minutes; the window was widened so a quiet round
 * is not ended under players who are still deciding to join.)
 */
export const MIN_ROUND_TIMEOUT_MS = 60_000;
export const DEFAULT_ROUND_TIMEOUT_MS = 1_800_000;
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
 * How long before the automatic refund the players are ASKED.
 *
 * A quiet round that never reaches its cap is ended by the driver (the safety
 * valve above), but the players now get a real choice first: take the exact
 * refund, or keep waiting. The prompt is shown for `REFUND_WINDOW_MS` before
 * the round would otherwise be refunded, and choosing "keep waiting" pushes the
 * deadline out again — so a round with active players is never ended under
 * them. `0` (or `ROUND_TIMEOUT_MS=0`) keeps the old silent behaviour off too:
 * the valve is the only trigger, and the prompt is simply skipped.
 */
export const DEFAULT_REFUND_WINDOW_MS = 120_000;
export const MIN_REFUND_WINDOW_MS = 15_000;
export function refundWindowMs(): number {
  const raw = process.env.REFUND_WINDOW_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_REFUND_WINDOW_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_REFUND_WINDOW_MS;
  if (n <= 0) return 0;
  return Math.max(Math.round(n), MIN_REFUND_WINDOW_MS);
}

/**
 * How much extra wait one "keep waiting" choice buys. Each click re-arms the
 * round for another full `ROUND_TIMEOUT_MS`, so a player who wants to stay can
 * hold the round open indefinitely without ever depositing more.
 */
export function waitExtensionMs(): number {
  return roundTimeoutMs() > 0 ? roundTimeoutMs() : DEFAULT_ROUND_TIMEOUT_MS;
}

/**
 * The live refund decision of one lane, and the shape the API/UI renders.
 *
 * `openMs`        — how long the funded round has been observably OPEN
 * `deadline`      — epoch ms at which the refund happens if nobody waits
 * `msRemaining`   — countdown, clamped at 0
 * `status`        — "open"    = still filling, no prompt
 *                   "pending" = window armed, players are being asked
 *                   "refund"  = window closed, the driver refunds this tick
 * `canWait`       — a funded, not-yet-refunded round can always be extended
 */
export interface RefundWindow {
  active: boolean;
  status: "open" | "pending" | "refund";
  openMs: number;
  deadline: number | null;
  msRemaining: number;
  windowMs: number;
  canRefund: boolean;
  canWait: boolean;
}

const REFUND_WINDOW_INACTIVE: RefundWindow = {
  active: false,
  status: "open",
  openMs: 0,
  deadline: null,
  msRemaining: 0,
  windowMs: 0,
  canRefund: false,
  canWait: false,
};

/**
 * Read (and lazily arm) one round's refund decision window.
 *
 * Pure with respect to the chain: it only consults the driver's own open clock
 * and the window state, so every reader — the settlement tick, `/api/pools`,
 * `/api/round/current` — sees the SAME deadline. That matters: the UI must
 * count down to the moment the driver will actually refund, and the driver must
 * refund the moment the UI said it would.
 */
export function refundWindowFor(
  roundId: bigint,
  tier: number,
  deps: SettlementDriverDeps,
  seenAt: number,
  timeoutMs: number
): RefundWindow {
  if (timeoutMs <= 0) return REFUND_WINDOW_INACTIVE;
  // A window of 0 means "ask nobody": the round is still refunded at the
  // deadline, it just skips the prompt (the pre-choice behaviour).
  const windowMs = Math.max(0, Math.min(refundWindowMs(), timeoutMs));

  const now = Date.now();
  const refundAt = seenAt + timeoutMs;
  let deadline = store.refundDeadlineFor(roundId);

  // Arm the window only once the round is close to its refund deadline. A
  // freshly observed round (or one that was just extended) is left alone.
  if (deadline === null && windowMs > 0 && now >= refundAt - windowMs) {
    deadline = refundAt;
    store.armRefundWindow(roundId, deadline);
    if (store.markRefundPrompted(roundId)) {
      txLog.warn("settlement.refund_prompted", {
        roundId: roundId.toString(),
        tier,
        openMs: now - seenAt,
        refundInMs: Math.max(0, refundAt - now),
        network: deps.cfg.network,
      });
      broadcast({
        type: "refund_window",
        roundId: roundId.toString(),
        data: {
          tier,
          status: "pending",
          openMs: now - seenAt,
          deadline,
          msRemaining: Math.max(0, deadline - now),
          canRefund: true,
          canWait: true,
        },
      });
    }
  }

  if (deadline === null) {
    // No prompt is on the table. Either the round is still filling, or the
    // prompt is disabled — in which case only the deadline decides.
    if (now >= refundAt) {
      return {
        active: false,
        status: "refund",
        openMs: now - seenAt,
        deadline: refundAt,
        msRemaining: 0,
        windowMs,
        canRefund: false,
        canWait: false,
      };
    }
    return { ...REFUND_WINDOW_INACTIVE, openMs: now - seenAt };
  }

  const msRemaining = Math.max(0, deadline - now);
  if (msRemaining === 0) {
    return {
      active: true,
      status: "refund",
      openMs: now - seenAt,
      deadline,
      msRemaining: 0,
      windowMs,
      canRefund: false,
      canWait: false,
    };
  }
  return {
    active: true,
    status: "pending",
    openMs: now - seenAt,
    deadline,
    msRemaining,
    windowMs,
    canRefund: true,
    canWait: true,
  };
}

/**
 * Refund decision window of a lane's CURRENT round, for the public API.
 *
 * Best-effort and cheap: the round is already read by the caller, so this only
 * consults the in-memory window state. A lane with no funded OPEN round (or
 * with the valve disabled) reports `active: false`.
 */
export function laneRefundWindow(
  tier: number,
  deps: SettlementDriverDeps,
  round: RoundData | null
): RefundWindow {
  if (!round || round.legacy || round.status !== "OPEN" || round.pot <= 0n) {
    return REFUND_WINDOW_INACTIVE;
  }
  const timeoutMs = roundTimeoutMs();
  if (timeoutMs <= 0) return REFUND_WINDOW_INACTIVE;
  const seenAt = store.markOpenSeen(round.id);
  return refundWindowFor(round.id, tier, deps, seenAt, timeoutMs);
}

/**
 * Player action: "keep waiting".
 *
 * Extends the round's refund deadline by another full timeout and re-arms the
 * window so the countdown restarts. It cannot move a lamport, cannot pick a
 * winner and cannot cancel anything — it only tells the driver that somebody is
 * still at the table. A refund that is already executing (window closed) is
 * reported instead of silently ignored.
 */
export async function waitLongerOnRound(
  tier: number,
  deps: SettlementDriverDeps,
  roundId: bigint
): Promise<{ ok: boolean; status: string; detail: string; refundWindow: RefundWindow }> {
  const round = await deps.backend.getRound(roundId);
  const current = laneRefundWindow(tier, deps, round);
  if (!round || round.legacy || round.status !== "OPEN" || round.pot <= 0n) {
    return {
      ok: false,
      status: round?.status ?? "missing",
      detail: "this round is no longer waiting for a refund decision",
      refundWindow: current,
    };
  }
  if (current.status === "refund") {
    return {
      ok: false,
      status: "refunding",
      detail: "the refund for this round is already on its way — it will land in your wallet",
      refundWindow: current,
    };
  }

  const now = Date.now();
  // Re-anchor the open clock so the round is treated as freshly observed: it is
  // no longer inside a decision window, and a whole timeout must pass before it
  // can be refunded again. `clearRefundWindow` also drops the "prompted" flag,
  // so the next window re-announces itself to the players.
  store.clearOpenSeen(roundId);
  store.clearRefundWindow(roundId);
  store.markOpenSeen(roundId, now);
  const deadline = now + waitExtensionMs();

  broadcast({
    type: "refund_window",
    roundId: roundId.toString(),
    data: {
      tier,
      status: "extended",
      deadline,
      msRemaining: Math.max(0, deadline - now),
      canRefund: true,
      canWait: true,
    },
  });
  txLog.info("settlement.refund_window_extended", {
    roundId: roundId.toString(),
    tier,
    deadline,
    network: deps.cfg.network,
  });

  return {
    ok: true,
    status: "extended",
    detail: "the round will keep waiting — you can join again or stay until it fills",
    refundWindow: laneRefundWindow(tier, deps, round),
  };
}

/**
 * Player action: "send my deposit back now".
 *
 * Immediately ends the round with the SAME on-chain primitive the timeout uses
 * (`cancel_round`): every participant is refunded EXACTLY from escrow, then the
 * lane reopens so deposits can proceed. Any player in the round may trigger it
 * — the money can only ever go back to the participants, so there is no theft
 * vector, and it is exactly the outcome the timeout would have produced a
 * moment later.
 */
export async function requestRoundRefund(
  tier: number,
  deps: SettlementDriverDeps,
  roundId: bigint
): Promise<{ ok: boolean; status: string; detail: string; signature: string | null; newRoundId: string | null; refundWindow: RefundWindow }> {
  const round = await deps.backend.getRound(roundId);
  if (!round || round.legacy || round.status !== "OPEN" || round.pot <= 0n) {
    return {
      ok: false,
      status: round?.status ?? "missing",
      detail: "this round is not accepting a refund decision",
      signature: null,
      newRoundId: null,
      refundWindow: REFUND_WINDOW_INACTIVE,
    };
  }

  const seenAt = store.openSeenAtFor(roundId) ?? Date.now();
  const outcome = await resetStaleOpenRound(tier, deps, roundId, seenAt);
  return {
    ok: outcome.cancelled,
    status: outcome.cancelled ? "refunded" : "cancelled_failed",
    detail: outcome.cancelled
      ? "your deposit was refunded exactly and the pool reopened"
      : "the refund could not be submitted right now — the round stays open, try again in a moment",
    signature: outcome.signature,
    newRoundId: outcome.newRoundId,
    refundWindow: REFUND_WINDOW_INACTIVE,
  };
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
): Promise<{ cancelled: boolean; signature: string | null; newRoundId: string | null }> {
  const { backend } = deps;
  const cancelled = await backend.runLifecycle("cancel", { roundId });
  if (!cancelled) {
    // A failed cancel (RPC hiccup, program rejection) must not retry on every
    // tick: re-arm the clock so the next attempt waits another full timeout.
    store.clearOpenSeen(roundId);
    store.clearRefundWindow(roundId);
    txLog.warn("settlement.stale_round_cancel_failed", {
      roundId: roundId.toString(),
      tier,
      network: deps.cfg.network,
    });
    return { cancelled: false, signature: null, newRoundId: null };
  }
  store.clearOpenSeen(roundId);
  store.clearRefundWindow(roundId);
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
    data: {
      tier,
      reason: "stale_round_refunded",
      openMs: Date.now() - seenAt,
      refunded: true,
    },
  });
  broadcast({
    type: "refund_window",
    roundId: roundId.toString(),
    data: { tier, status: "refunded", canRefund: false, canWait: false },
  });
  txLog.warn("settlement.stale_round_cancelled", {
    roundId: roundId.toString(),
    tier,
    openMs: Date.now() - seenAt,
    signature: cancelled.signature,
    orphanedEntries: orphaned,
    network: deps.cfg.network,
  });
  const next = await openNextRound(tier, deps, roundId);
  return {
    cancelled: true,
    signature: cancelled.signature,
    newRoundId: next?.roundId.toString() ?? null,
  };
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
