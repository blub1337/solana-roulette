/** RPC-backed VerifyDeps + round/participant fetching (Node). */
import { PublicKey, type Connection } from "@solana/web3.js";
import { decodeRound, decodeParticipant, type RoundData, type ParticipantData } from "./accounts.js";
import { getRoundPda } from "./pda.js";
import { deriveRandomness } from "./winner.js";
import type { VerifyDeps } from "./verifyRound.js";

export const PARTICIPANT_DATA_SIZE = 101; // PARTICIPANT_SPACE

export async function fetchRoundAccount(
  connection: Connection,
  programId: PublicKey,
  roundId: bigint
): Promise<RoundData | null> {
  const [roundKey] = getRoundPda(programId, roundId);
  const info = await connection.getAccountInfo(roundKey);
  if (!info?.data) return null;
  return decodeRound(info.data);
}

export async function fetchParticipantsForRound(
  connection: Connection,
  programId: PublicKey,
  roundKey: PublicKey
): Promise<ParticipantData[]> {
  const accounts = await connection.getProgramAccounts(programId, {
    filters: [
      { dataSize: PARTICIPANT_DATA_SIZE },
      { memcmp: { offset: 8, bytes: roundKey.toBase58() } }, // first field = round pubkey
    ],
  });
  return accounts.map(({ account }) => decodeParticipant(account.data)).sort((a, b) => a.index - b.index);
}

export function makeRpcVerifyDeps(
  connection: Connection,
  programId: PublicKey,
  roundKey: PublicKey
): VerifyDeps {
  return {
    fetchRound: async (roundId: bigint) => fetchRoundAccount(connection, programId, roundId),
    fetchParticipants: async () => fetchParticipantsForRound(connection, programId, roundKey),
    fetchRevealBlockhash: async (revealSlot: bigint) => {
      try {
        const block = await connection.getBlock(Number(revealSlot), { maxSupportedTransactionVersion: 0 });
        return block ? base58ToBytes(block.blockhash) : null;
      } catch {
        return null; // slot too old / not yet produced / RPC error
      }
    },
    deriveRandomness,
  };
}

function base58ToBytes(s: string): Uint8Array {
  // PublicKey decodes base58; reuse it to avoid a bs58 dependency.
  return new Uint8Array(new PublicKey(s).toBytes());
}
