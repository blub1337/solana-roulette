/**
 * Node entry for winner math: sync entropy via node:crypto, pure shared math
 * re-exported from winnerCore (byte-identical to the WebCrypto twin in
 * winner.browser.ts — see entropyParity.test.ts).
 */
import { createHash } from "node:crypto";

export * from "./winnerCore.js";

/** randomness = SHA256(b"roulette:reveal" ‖ round_id_le_u64 ‖ blockhash) */
export function deriveRandomness(revealBlockhash: Uint8Array, roundId: bigint): Uint8Array {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(roundId);
  return new Uint8Array(
    createHash("sha256")
      .update(Buffer.from("roulette:reveal", "utf8"))
      .update(idBuf)
      .update(Buffer.from(revealBlockhash))
      .digest()
  );
}
