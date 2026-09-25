/**
 * Node convenience layer: fetch + verify one round end-to-end.
 * Thin composition over accounts.ts + rpc.ts + verifyRound.ts.
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import type { RoundData } from "./accounts";
import { getRoundPda, getEscrowPda, getParticipantPda } from "./pda";
import { fetchRoundAccount, fetchParticipantsForRound } from "./rpc";
import { makeRpcVerifyDeps } from "./rpc";
import { verifyRoundData, type VerificationOutcome } from "./verifyRound";

/** Fetch + verify in one call. Returns null when the round does not exist. */
export async function verifyRoundById(
  connection: Connection,
  programId: PublicKey,
  roundId: bigint
): Promise<(VerificationOutcome & { round: RoundData; escrow: string }) | null> {
  const round = await fetchRoundAccount(connection, programId, roundId);
  if (!round) return null;
  const roundKey = getRoundPda(programId, roundId)[0];
  const outcome = await verifyRoundData(round, makeRpcVerifyDeps(connection, programId, roundKey));
  const escrow = getEscrowPda(programId, roundId)[0].toBase58();
  return { ...outcome, round, escrow };
}

/** Account keys for a round: round PDA, escrow PDA, participant PDA. */
export function roundAccountKeys(programId: PublicKey, roundId: bigint, wallet?: PublicKey) {
  return {
    round: getRoundPda(programId, roundId)[0],
    escrow: getEscrowPda(programId, roundId)[0],
    participant: wallet ? getParticipantPda(programId, roundId, wallet)[0] : null,
  };
}

export { fetchRoundAccount, fetchParticipantsForRound };
