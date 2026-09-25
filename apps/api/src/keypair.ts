/**
 * Operator keypair loading — DEVNET ONLY. Accepts a JSON array (solana-keygen
 * output) or a base58 secret key. The keypair signs ONLY lifecycle
 * instructions; the program controls all fund movement.
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export function loadOperatorKeypair(json: string | null | undefined): Keypair | null {
  const raw = json?.trim();
  if (!raw) return null;
  if (raw.startsWith("[")) {
    const arr = JSON.parse(raw) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(raw)) {
    return Keypair.fromSecretKey(bs58.decode(raw));
  }
  console.warn("[operator] OPERATOR_KEYPAIR present but unparsable (expected JSON array or base58)");
  return null;
}
