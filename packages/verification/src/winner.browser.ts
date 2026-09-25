/**
 * Browser entry for winner math: entropy via WebCrypto (async), shared pure
 * math re-exported from winnerCore (identical output to the Node entry).
 */

export * from "./winnerCore";

/** randomness = SHA256(b"roulette:reveal" ‖ round_id_le_u64 ‖ blockhash) */
export async function deriveRandomness(
  revealBlockhash: Uint8Array,
  roundId: bigint
): Promise<Uint8Array> {
  const idBuf = new Uint8Array(8);
  new DataView(idBuf.buffer).setBigUint64(0, roundId, true);
  const payload = new Uint8Array(15 + 8 + revealBlockhash.length);
  payload.set(new TextEncoder().encode("roulette:reveal"), 0);
  payload.set(idBuf, 15);
  payload.set(revealBlockhash, 23);
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return new Uint8Array(digest);
}
