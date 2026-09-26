/**
 * Run the EXISTING devnet smoke test (scripts/devnet-smoke.mjs) with the
 * operator key supplied from disk, so the secret never has to be pasted into
 * a shell command or an env file.
 */
import { readFileSync } from "node:fs";

process.env.OPERATOR_KEYPAIR ??= readFileSync("operator-devnet.key.json", "utf8").trim();
process.env.SOLANA_RPC_URL ??= "https://api.devnet.solana.com";
process.env.ROULETTE_PROGRAM_ID ??= "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos";

await import("./devnet-smoke.mjs");
