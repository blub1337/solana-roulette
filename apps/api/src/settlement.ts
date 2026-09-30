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
import type { AppConfig } from "@solana-roulette/config";
import { TIER_COUNT, isTerminalState } from "@solana-roulette/types";
import type { ChainBackend } from "./backend.js";
import { requireFeeWallet } from "./operator.js";
import { store, broadcast } from "./store.js";
import { txLog } from "./logger.js";
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
}

let started = false;

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

export function startSettlementDriver(deps: SettlementDriverDeps): void {
  if (started) return;
  started = true;

  const intervalMs = Number(process.env.SETTLEMENT_POLL_MS ?? 5_000);
  const tick = createGuardedTick(deps);

  const safeTick = async () => {
    try {
      await tick();
    } catch (e) {
      console.warn("[settlement]", e instanceof Error ? e.message : e);
    }
  };

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

  if (!round || isTerminalState(round.status)) {
    await openNextRound(tier, deps, round?.id);
    return;
  }
  if (round.tier !== tier) return; // lane discipline: never advance another tier's round
  store.currentRoundIdByTier[tier] = round.id;
  const roundId = round.id;

  switch (round.status) {
    case "OPEN": {
      // The pool cap is enforced by the runtime; a round only leaves OPEN by
      // hitting exactly the tier cap. Nothing to do but wait.
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
async function openNextRound(tier: number, deps: SettlementDriverDeps, previousId?: bigint): Promise<void> {
  const { backend, cfg } = deps;
  // No explicit id: the runtime allocates `counter + 1`, which is what the
  // program enforces. Deriving `previousId + 1` would collide across lanes.
  const created = await backend.runLifecycle("create", { tier });
  if (!created) return;
  store.currentRoundIdByTier[tier] = created.roundId;
  broadcast({ type: "new_round", roundId: created.roundId.toString(), data: { tier, previous: previousId?.toString() } });
  store.upsertRound({ id: created.roundId.toString(), tier, status: "OPEN", feeBps: cfg.feeBps });
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
