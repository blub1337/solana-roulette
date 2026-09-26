/**
 * Make a REAL devnet deposit into an open round and verify it on chain.
 *
 *   node scripts/devnet-deposit.mjs [roundId] [solAmount]
 *
 * The operator wallet is used as the depositor (the only key this workspace
 * holds). Proves the whole player path works: the participant PDA is created,
 * the pot grows, and the lamports really land in the escrow.
 */
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { depositIx, roundPda, participantPda } = require("../packages/sdk/dist/index.js");

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.ROULETTE_PROGRAM_ID || "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos"
);
const roundId = BigInt(process.argv[2] ?? 1);
const amount = BigInt(Math.round(Number(process.argv[3] ?? 0.01) * 1e9));

const connection = new Connection(RPC, "confirmed");
const depositor = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync("operator-devnet.key.json", "utf8")))
);
const explorer = (s) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;

const round = roundPda(PROGRAM_ID, roundId);
const roundAcc = await connection.getAccountInfo(round, "confirmed");
if (!roundAcc) {
  console.error(`round ${roundId} does not exist`);
  process.exit(1);
}
const data = roundAcc.data;
const status = data[16];
const escrow = new PublicKey(data.subarray(17, 49));
const potBefore = data.readBigUInt64LE(49);
const feeBps = data.readUInt16LE(93);
const minDeposit = 10_000_000n;
const maxDeposit = 1_000_000_000n;

console.log(`round       ${roundId} (${round.toBase58()})`);
console.log(`  status    ${status} (0 = Open)`);
console.log(`  escrow    ${escrow.toBase58()}`);
console.log(`  pot       ${potBefore} lamports`);
console.log(`  fee_bps   ${feeBps}`);
console.log(`depositing  ${amount} lamports (${Number(amount) / 1e9} SOL) from ${depositor.publicKey.toBase58()}\n`);

if (status !== 0) {
  console.error("round is not OPEN — nothing sent");
  process.exit(1);
}
if (amount < minDeposit || amount > maxDeposit) {
  console.error(`amount must be within [${minDeposit}, ${maxDeposit}] lamports`);
  process.exit(1);
}

const escrowBefore = (await connection.getAccountInfo(escrow, "confirmed")).lamports;
const ix = depositIx(PROGRAM_ID, depositor.publicKey, roundId, amount);
const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
const tx = new Transaction({ feePayer: depositor.publicKey, blockhash, lastValidBlockHeight }).add(ix);
tx.partialSign(depositor);

const sig = await sendAndConfirmTransaction(connection, tx, [depositor], { commitment: "confirmed" });
console.log(`signature   ${sig}`);
console.log(`explorer    ${explorer(sig)}\n`);

const after = (await connection.getAccountInfo(round, "confirmed")).data;
const potAfter = after.readBigUInt64LE(49);
const countAfter = after.readUInt32LE(73);
const escrowAfter = (await connection.getAccountInfo(escrow, "confirmed")).lamports;
const partKey = participantPda(PROGRAM_ID, round, depositor.publicKey);
const part = await connection.getAccountInfo(partKey, "confirmed");

console.log(`  pot        ${potBefore} -> ${potAfter} lamports`);
console.log(`  escrow     ${escrowBefore} -> ${escrowAfter} lamports (+${escrowAfter - escrowBefore})`);
console.log(`  entrants   ${countAfter}`);
console.log(`  participant ${partKey.toBase58()}`);
console.log(`    ${part ? `created, ${part.data.length} bytes, amount ${part.data.readBigUInt64LE(72)} lamports` : "MISSING"}`);

const potOk = potAfter === potBefore + amount;
// lamports come back as a JS number, so widen before comparing with a bigint.
const escrowOk = BigInt(escrowAfter - escrowBefore) === amount;
const partOk = Boolean(part) && part.data.readBigUInt64LE(72) === amount;
console.log(
  `\n${potOk && escrowOk && partOk ? "DEPOSIT VERIFIED ON DEVNET" : "MISMATCH — pot/escrow/participant disagree"}`
);
process.exit(potOk && escrowOk && partOk ? 0 : 1);
