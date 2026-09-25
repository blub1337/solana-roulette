/**
 * Canonical PDA seeds — MUST match programs/roulette/src/lib.rs exactly.
 */
import { PublicKey } from "@solana/web3.js";

export const SEED_CONFIG = "config";
export const SEED_ROUND = "round";
export const SEED_ESCROW = "escrow";
export const SEED_PARTICIPANT = "participant";

export function configPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(SEED_CONFIG)], programId)[0];
}

export function roundPda(programId: PublicKey, roundId: bigint | number): PublicKey {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(BigInt(roundId));
  return PublicKey.findProgramAddressSync([Buffer.from(SEED_ROUND), idBuf], programId)[0];
}

export function escrowPda(programId: PublicKey, roundKey: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(SEED_ESCROW), roundKey.toBuffer()], programId)[0];
}

export function participantPda(programId: PublicKey, roundKey: PublicKey, wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_PARTICIPANT), roundKey.toBuffer(), wallet.toBuffer()],
    programId
  )[0];
}
