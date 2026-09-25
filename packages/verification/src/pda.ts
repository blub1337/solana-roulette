import { PublicKey } from "@solana/web3.js";

export const PROGRAM_SEEDS = {
  config: "config",
  round: "round",
  participant: "participant",
  escrow: "escrow",
} as const;

function roundIdSeed(roundId: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(roundId);
  return buf;
}

export function getGlobalConfigPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(PROGRAM_SEEDS.config)], programId);
}

export function getRoundPda(programId: PublicKey, roundId: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PROGRAM_SEEDS.round), roundIdSeed(roundId)],
    programId
  );
}

/**
 * Escrow PDA. Accepts either the round id (bigint) or the already-derived
 * round key (PublicKey). The Rust program uses seeds ["escrow", round.key()],
 * so a round id is first converted to the round PDA here.
 */
export function getEscrowPda(
  programId: PublicKey,
  roundIdOrKey: bigint | PublicKey
): [PublicKey, number] {
  const roundSeed =
    typeof roundIdOrKey === "bigint" ? getRoundPda(programId, roundIdOrKey)[0].toBuffer() : roundIdOrKey.toBuffer();
  return PublicKey.findProgramAddressSync([Buffer.from(PROGRAM_SEEDS.escrow), roundSeed], programId);
}

export function getParticipantPda(
  programId: PublicKey,
  roundIdOrKey: bigint | PublicKey,
  wallet: PublicKey
): [PublicKey, number] {
  const roundSeed =
    typeof roundIdOrKey === "bigint" ? getRoundPda(programId, roundIdOrKey)[0].toBuffer() : roundIdOrKey.toBuffer();
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PROGRAM_SEEDS.participant), roundSeed, wallet.toBuffer()],
    programId
  );
}
