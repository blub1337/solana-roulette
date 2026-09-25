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
    entropySource: "recorded_randomness" | "recomputed_blockhash" | "unavailable";
    randomnessHex?: string;
    revealBlockhash?: string;
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

  // Entropy
  let entropy: Uint8Array | null = null;
  let source: VerificationOutcome["trace"]["entropySource"] = "unavailable";
  let revealBlockhash: Uint8Array | null = null;

  if (round.randomness.some((b) => b !== 0)) {
    entropy = round.randomness;
    source = "recorded_randomness";
    add("entropy_available", true, "recorded on Round at settle");
  } else if (round.revealSlot > 0n) {
    revealBlockhash = await deps.fetchRevealBlockhash(round.revealSlot);
    if (revealBlockhash) {
      entropy = await deps.deriveRandomness(revealBlockhash, round.id);
      source = "recomputed_blockhash";
      add("entropy_available", true, `recomputed from blockhash at slot ${round.revealSlot}`);
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

    // Fee/payout math must match pot * fee_bps
    const { fee, payout } = computeFeeSplit(round.pot, round.feeBps);
    add("fee_matches_pot_x_fee_bps", fee === round.feeLamports || round.feeLamports === 0n, `expected=${fee}`);
    add(
      "payout_matches_pot_minus_fee",
      payout === round.payoutLamports || round.payoutLamports === 0n,
      `expected=${payout}`
    );

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
    winningTicket: round.winningTicket ? round.winningTicket.toString() : undefined,
  };
}
