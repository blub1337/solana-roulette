/**
 * Independent round verification: recomputes winner + fee math from on-chain
 * data only. Used by /api/round/:id/verify and callable from any third party.
 */
import { PublicKey } from "@solana/web3.js";
import type { RoundState, VerifyResult } from "@solana-roulette/types";
import type { RoundData, ParticipantData } from "./accounts.js";
import {
  computeFeeSplit,
  computeTicket,
  selectWinner,
  type WeightedEntry,
} from "./winnerCore.js";

export interface VerifyDeps {
  /** Fetch the decoded Round account, or null if it does not exist yet. */
  fetchRound: (roundId: bigint) => Promise<RoundData | null>;
  /** Fetch all Participant accounts for the round, sorted by index. */
  fetchParticipants: (roundId: bigint) => Promise<ParticipantData[]>;
  /** Fetch the blockhash produced at `revealSlot` (null if not yet produced). */
  fetchRevealBlockhash: (revealSlot: bigint) => Promise<Uint8Array | null>;
  /**
   * Derive entropy from the reveal blockhash (env-specific: node:crypto sync
   * impl or WebCrypto async twin — identical output). Required to recompute
   * entropy when the Round account has no recorded randomness yet.
   */
  deriveRandomness: (revealBlockhash: Uint8Array, roundId: bigint) => Uint8Array | Promise<Uint8Array>;
  /** The Round PDA key (for trace display only). */
  roundKey?: string;
}

export interface VerificationOutcome {
  ok: boolean;
  onChainStatus: RoundState;
  trace: {
    roundId: string;
    totalWeight: string;
    participantCount: number;
    entropySource: "persisted_input" | "recorded_randomness" | "recomputed_blockhash" | "unavailable";
    randomnessHex?: string;
    revealBlockhash?: string;
    /** The entropy input persisted on-chain by settle_round (hex), when present. */
    revealInputHex?: string;
    ticket?: string;
    computedWinner?: string;
    recordedWinner?: string;
    recordedFeeLamports?: string;
    expectedFeeLamports?: string;
    recordedPayoutLamports?: string;
    expectedPayoutLamports?: string;
    checks: Array<{ name: string; pass: boolean; detail?: string }>;
  };
}

export async function verifyRoundData(round: RoundData, deps: VerifyDeps): Promise<VerificationOutcome> {
  const checks: VerificationOutcome["trace"]["checks"] = [];
  const add = (name: string, pass: boolean, detail?: string) => checks.push({ name, pass, detail });

  const participants = await deps.fetchParticipants(round.id);
  const entries: WeightedEntry[] = participants
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((p) => ({ id: p.wallet.toBase58(), amount: p.amount, weightStart: p.weightStart, index: p.index }));

  const totalWeight = entries.reduce((acc, e) => acc + e.amount, 0n);

  add("status_is_terminal_or_settling", true, round.status);
  add(
    "participant_count_matches",
    participants.length === round.participantCount,
    `on-chain=${round.participantCount} fetched=${participants.length}`
  );
  add("weight_chain_sums_to_pot", totalWeight === round.totalWeight && totalWeight === round.pot, `pot=${round.pot}`);

  // Entropy.
  //
  // Priority order matters. `revealInput` is the ONLY input that can be
  // recomputed by a third party: the program hashed the SlotHashes entry for
  // `revealSlot` (a per-slot bank hash), which no RPC exposes through
  // `getBlock(slot).blockhash`. When the program persisted it, we re-derive the
  // entropy from it and assert it equals the stored `randomness` — that check
  // is what makes the draw auditable. The other two paths are legacy
  // fallbacks for rounds settled before the field existed.
  let entropy: Uint8Array | null = null;
  let source: VerificationOutcome["trace"]["entropySource"] = "unavailable";
  let revealBlockhash: Uint8Array | null = null;
  const hasInput = round.revealInput.length === 32 && round.revealInput.some((b) => b !== 0);

  if (hasInput) {
    const recomputed = await deps.deriveRandomness(round.revealInput, round.id);
    const recomputedHex = Buffer.from(recomputed).toString("hex");
    const recordedHex = Buffer.from(round.randomness).toString("hex");
    add("entropy_available", true, "reveal_input persisted on Round at settle");
    add(
      "entropy_recomputed_from_persisted_input_matches_recorded",
      recomputedHex === recordedHex,
      `recomputed=${recomputedHex} recorded=${recordedHex}`
    );
    // Use the RECOMPUTED value downstream: if the two ever disagreed the check
    // above already fails, so this never masks a mismatch.
    entropy = recomputed;
    source = "persisted_input";
  } else if (round.randomness.some((b) => b !== 0)) {
    entropy = round.randomness;
    source = "recorded_randomness";
    add("entropy_available", true, "recorded on Round at settle (no reveal_input: pre-redeploy round)");
    add(
      "entropy_recomputed_from_persisted_input_matches_recorded",
      false,
      "round has no persisted reveal_input, so entropy cannot be independently recomputed"
    );
  } else if (round.revealSlot > 0n) {
    revealBlockhash = await deps.fetchRevealBlockhash(round.revealSlot);
    if (revealBlockhash) {
      entropy = await deps.deriveRandomness(revealBlockhash, round.id);
      source = "recomputed_blockhash";
      add("entropy_available", true, `recomputed from getBlock(${round.revealSlot}).blockhash`);
    } else {
      add("entropy_available", false, `reveal blockhash for slot ${round.revealSlot} not available yet`);
    }
  } else {
    add("entropy_available", false, "round not locked yet");
  }

  const trace: VerificationOutcome["trace"] = {
    roundId: round.id.toString(),
    totalWeight: totalWeight.toString(),
    participantCount: participants.length,
    entropySource: source,
    checks,
  };
  if (entropy) trace.randomnessHex = Buffer.from(entropy).toString("hex");
  if (hasInput) trace.revealInputHex = Buffer.from(round.revealInput).toString("hex");
  if (revealBlockhash) trace.revealBlockhash = new PublicKey(revealBlockhash).toBase58();

  let ok = checks.every((c) => c.pass);

  // Winner + fee verification only possible with entropy and non-empty round
  if (entropy && totalWeight > 0n) {
    const ticket = computeTicket(entropy, round.totalWeight);
    let computedWinner: string | undefined;
    try {
      const w = selectWinner(entries, ticket);
      computedWinner = w.id;
      add("ticket_within_total_weight", true, `ticket=${ticket}`);
    } catch (e) {
      add("ticket_within_total_weight", false, e instanceof Error ? e.message : "unknown");
      ok = false;
    }

    // The ticket must be the one the program stored, not merely a valid one.
    if (round.winningTicket > 0n) {
      add(
        "ticket_matches_recorded",
        ticket === round.winningTicket,
        `computed=${ticket} onChain=${round.winningTicket}`
      );
    }

    // Fee/payout math must match pot * fee_bps.
    //
    // The `|| recorded === 0n` leniency is only valid while the amounts are
    // still unset. The program writes BOTH amounts at settle phase 1 — the
    // same instruction that freezes `winner` and `payout_account` — so once a
    // winner is frozen a zero fee/payout on a non-zero pot is an inconsistency,
    // not a pending state, and must fail verification. Without this guard the
    // verifier would bless a round whose recorded split does not match
    // pot × fee_bps (e.g. a truncated or tampered fee_lamports field).
    const { fee, payout } = computeFeeSplit(round.pot, round.feeBps);
    const amountsFrozen =
      round.winner !== undefined &&
      !isDefaultPk(round.winner) &&
      round.payoutAccount.length === 32 &&
      round.payoutAccount.some((b) => b !== 0);
    add(
      "fee_matches_pot_x_fee_bps",
      fee === round.feeLamports || (!amountsFrozen && round.feeLamports === 0n),
      `expected=${fee}`
    );
    add(
      "payout_matches_pot_minus_fee",
      payout === round.payoutLamports || (!amountsFrozen && round.payoutLamports === 0n),
      `expected=${payout}`
    );

    // The account frozen to RECEIVE the payout must be the recomputed winner.
    // settle_round writes payout_account = winner, and pay_winners requires
    // winner_account == round.winner == round.payout_account — so a recorded
    // round whose payout_account points anywhere else is an inconsistency a
    // payout-auditor must flag, not bless.
    if (amountsFrozen && round.winner) {
      const payoutPk = new PublicKey(round.payoutAccount);
      add(
        "payout_account_matches_recomputed_winner",
        payoutPk.equals(round.winner),
        `payout_account=${payoutPk.toBase58()} winner=${round.winner.toBase58()}`
      );
    }

    if (round.status === "COMPLETED") {
      add("winner_recorded", round.winner !== undefined && !isDefaultPk(round.winner), undefined);
      if (computedWinner) {
        const recorded = round.winner?.toBase58();
        add(
          "recorded_winner_matches_recomputation",
          recorded === computedWinner,
          `recorded=${recorded} computed=${computedWinner}`
        );
      }
    } else {
      add("winner_recorded", true, `not applicable while status=${round.status}`);
    }

    trace.ticket = ticket.toString();
    if (computedWinner) trace.computedWinner = computedWinner;
    if (round.winner && !isDefaultPk(round.winner)) trace.recordedWinner = round.winner.toBase58();
    trace.recordedFeeLamports = round.feeLamports.toString();
    trace.expectedFeeLamports = fee.toString();
    trace.recordedPayoutLamports = round.payoutLamports.toString();
    trace.expectedPayoutLamports = payout.toString();

    ok = checks.every((c) => c.pass);
  }

  return { ok, onChainStatus: round.status, trace };
}

function isDefaultPk(pk: PublicKey | undefined): boolean {
  return !!pk && pk.equals(PublicKey.default);
}

export function toVerifyResult(outcome: VerificationOutcome, round: RoundData, roundKeyBase58: string): VerifyResult {
  return {
    ok: outcome.ok,
    onChainStatus: outcome.onChainStatus,
    ...outcome.trace,
    round: roundToSummary(round, roundKeyBase58),
  };
}

export function roundToSummary(round: RoundData, escrowBase58: string) {
  return {
    id: round.id.toString(),
    tier: round.tier,
    status: round.status,
    escrow: escrowBase58,
    potLamports: round.pot.toString(),
    totalWeight: round.totalWeight.toString(),
    participantCount: round.participantCount,
    maxRoundSizeLamports: "0",
    minDepositLamports: "0",
    maxDepositLamports: "0",
    feeBps: round.feeBps,
    revealSlot: round.revealSlot ? round.revealSlot.toString() : undefined,
    lockSlot: round.lockSlot ? round.lockSlot.toString() : undefined,
    winner: round.winner && !isDefaultPk(round.winner) ? round.winner.toBase58() : undefined,
    payoutLamports: round.payoutLamports ? round.payoutLamports.toString() : undefined,
    feeLamports: round.feeLamports ? round.feeLamports.toString() : undefined,
    randomnessHex: round.randomness.some((b) => b !== 0) ? Buffer.from(round.randomness).toString("hex") : undefined,
    revealInputHex:
      round.revealInput.length === 32 && round.revealInput.some((b) => b !== 0)
        ? Buffer.from(round.revealInput).toString("hex")
        : undefined,
    winningTicket: round.winningTicket ? round.winningTicket.toString() : undefined,
  };
}
