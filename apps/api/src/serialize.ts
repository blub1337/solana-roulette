/** Serializers: on-chain decoded accounts -> API DTOs. */
import type { AppConfig } from "@solana-roulette/config";
import type { RoundData, ParticipantData } from "@solana-roulette/verification";
import type { RoundSummary, EntryDto } from "@solana-roulette/types";

export function roundToDto(round: RoundData, cfg: AppConfig): RoundSummary {
  const hasWinner = round.status === "COMPLETED";
  // Pool cap of THIS round's tier (on-chain tier_caps, fallback to env caps).
  const tierCap = cfg.tierCapsLamports[round.tier] ?? cfg.maxRoundSizeLamports;
  return {
    id: round.id.toString(),
    tier: round.tier,
    status: round.status,
    escrow: round.escrow.toBase58(),
    potLamports: round.pot.toString(),
    totalWeight: round.totalWeight.toString(),
    participantCount: round.participantCount,
    maxRoundSizeLamports: tierCap.toString(),
    minDepositLamports: cfg.minDepositLamports.toString(),
    maxDepositLamports: cfg.maxDepositLamports.toString(),
    feeBps: round.feeBps,
    lockSlot: round.lockSlot ? round.lockSlot.toString() : undefined,
    revealSlot: round.revealSlot ? round.revealSlot.toString() : undefined,
    winner: hasWinner ? round.winner.toBase58() : undefined,
    payoutLamports: hasWinner ? round.payoutLamports.toString() : undefined,
    feeLamports: hasWinner ? round.feeLamports.toString() : undefined,
    randomnessHex: hasWinner ? Buffer.from(round.randomness).toString("hex") : undefined,
    winningTicket: hasWinner ? round.winningTicket.toString() : undefined,
  };
}

export function entryToDto(p: ParticipantData): EntryDto {
  return {
    wallet: p.wallet.toBase58(),
    amountLamports: p.amount.toString(),
    weightStart: p.weightStart.toString(),
    index: p.index,
    verified: true,
  };
}
