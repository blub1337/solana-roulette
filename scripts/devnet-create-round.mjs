/**
 * Open a REAL round on Solana devnet through the SDK instruction builder and
 * verify the on-chain Round account afterwards.
 *
 *   node scripts/devnet-create-round.mjs [tier]
 *
 * Signs with the devnet operator keypair (operator-devnet.key.json). The
 * operator is the only key this workspace holds; it is also allowed to be the
 * depositor. Prints the transaction signature and explorer link.
 */
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createRoundInstruction, configPda, roundPda } = require("../packages/sdk/dist/index.js");

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.ROULETTE_PROGRAM_ID || "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos"
);
const TIER = Number(process.argv[2] ?? 0);
const connection = new Connection(RPC, "confirmed");
const operator = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync("operator-devnet.key.json", "utf8")))
);
const explorer = (s) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;

// ---- read the on-chain counter ----
const config = configPda(PROGRAM_ID);
const cfg = (await connection.getAccountInfo(config, "confirmed")).data;
const counter = cfg.readBigUInt64LE(106);
const feeBps = cfg.readUInt16LE(72);
const roundId = counter + 1n;
const roundKey = roundPda(PROGRAM_ID, roundId);

console.log(`program    ${PROGRAM_ID.toBase58()}`);
console.log(`operator   ${operator.publicKey.toBase58()}`);
console.log(`config     ${config.toBase58()}`);
console.log(`fee_bps    ${feeBps}`);
console.log(`counter    ${counter} -> creating round ${roundId} (tier ${TIER})`);
console.log(`round PDA  ${roundKey.toBase58()}`);

if ((await connection.getAccountInfo(roundKey, "confirmed"))) {
  console.log("\nround already exists — nothing to do");
  process.exit(0);
}

// ---- build + send ----
const ix = createRoundInstruction(PROGRAM_ID, operator.publicKey, roundId, TIER);
const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
const tx = new Transaction({ feePayer: operator.publicKey, blockhash, lastValidBlockHeight }).add(ix);
// Only the operator signs: `round` and `escrow` are PDAs the program creates
// for itself, so the client must pass them as plain writable accounts.
tx.partialSign(operator);

const balanceBefore = await connection.getBalance(operator.publicKey, "confirmed");
const sig = await sendAndConfirmTransaction(connection, tx, [operator], { commitment: "confirmed" });
const balanceAfter = await connection.getBalance(operator.publicKey, "confirmed");

console.log(`\nsignature  ${sig}`);
console.log(`explorer   ${explorer(sig)}`);
console.log(`operator   ${balanceBefore} -> ${balanceAfter} lamports (rent for round + escrow)`);

// ---- verify on chain ----
const roundAcc = await connection.getAccountInfo(roundKey, "confirmed");
const round = roundAcc.data;
const u64 = (o) => round.readBigUInt64LE(o);
console.log(`\nRound account ${roundKey.toBase58()}`);
console.log(`  owner        ${roundAcc.owner.toBase58()}`);
console.log(`  space        ${round.length} bytes`);
console.log(`  id           ${u64(8)}`);
console.log(`  status       ${round[16]} (0 = Open)`);
console.log(`  escrow       ${new PublicKey(round.subarray(17, 49)).toBase58()}`);
console.log(`  pot          ${u64(49)} lamports`);
console.log(`  fee_bps      ${round.readUInt16LE(93)}`);
console.log(`  tier         ${round[223]}`);

const ok = u64(8) === roundId && round[16] === 0;
console.log(`\n${ok ? "ROUND CREATED ON DEVNET" : "UNEXPECTED ROUND STATE"}`);
process.exit(ok ? 0 : 1);
