/**
 * One-off: validates that OPERATOR_KEYPAIR (from the environment) parses and
 * matches the expected devnet operator address. Prints ONLY the public
 * address and a yes/no verdict — never any secret material.
 *
 * Merge mode: `node scripts/verify-operator-env.mjs --merge-file <path>`
 * reads a local file whose first line is `OPERATOR_KEYPAIR=<value>` and
 * verifies THAT value (still printing only the derived address), so the
 * operator can confirm a prepared merge file is correct before importing it
 * via `freebuff-env`.
 *
 * Run: node scripts/verify-operator-env.mjs [--merge-file <path>]
 */
import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const EXPECTED = "FgEPpAmLLiod4RyBhUcLdvpzPGiBdotoEawyPqyftg1q";
const mergeIdx = process.argv.indexOf("--merge-file");
let raw;
if (mergeIdx !== -1 && process.argv[mergeIdx + 1]) {
  const file = readFileSync(process.argv[mergeIdx + 1], "utf8");
  const line = file.split("\n").find((l) => l.startsWith("OPERATOR_KEYPAIR=")) ?? "";
  raw = line.slice("OPERATOR_KEYPAIR=".length).trim();
  console.log("source: merge file", process.argv[mergeIdx + 1]);
} else {
  raw = (process.env.OPERATOR_KEYPAIR || "").trim();
  console.log("source: environment");
}

if (!raw) {
  console.log("OPERATOR_KEYPAIR: not set");
  process.exit(0);
}

try {
  console.log("raw form:", raw.startsWith("[") ? "json-array" : raw.length + " chars");
  // Charset diagnosis (no value printed): positions of non-base58 characters.
  if (!raw.startsWith("[")) {
    const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
    const badIdx = [];
    for (let i = 0; i < raw.length; i++) if (!B58.test(raw[i])) badIdx.push(i);
    console.log("non-base58 char positions:", badIdx.length ? badIdx.slice(0, 6).join(",") : "none");
  }
  const secret = raw.startsWith("[")
    ? Uint8Array.from(JSON.parse(raw))
    : bs58.decode(raw);
  const addr = Keypair.fromSecretKey(secret).publicKey.toBase58();
  console.log("OPERATOR_KEYPAIR: parses OK");
  console.log("address:", addr);
  console.log("matches expected devnet operator:", addr === EXPECTED);
} catch (e) {
  console.log("OPERATOR_KEYPAIR: UNPARSABLE —", e.message.slice(0, 80));
}
