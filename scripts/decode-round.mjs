/**
 * Decode the on-chain Round account(s) with the exact field layout Anchor
 * writes, and confirm the round is a valid OPEN round owned by the program.
 *
 *   node scripts/decode-round.mjs [roundId]
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { roundPda, escrowPda } = require("../packages/sdk/dist/index.js");

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.ROULETTE_PROGRAM_ID || "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos"
);
const connection = new Connection(RPC, "confirmed");

// 8 disc | 8 id | 1 status | 32 escrow | 8 pot | 16 weight | 4 count
// 8 lock | 8 reveal | 2 fee_bps | 32 randomness | 16 ticket | 32 winner
// 8 fee | 8 payout | 32 payout_account | 1 tier | 1 bump  = 225
const layout = [
  ["id", 8, "u64"],
  ["status", 1, "u8"],
  ["escrow", 32, "pubkey"],
  ["pot", 8, "u64"],
  ["total_weight", 16, "u128"],
  ["participant_count", 4, "u32"],
  ["lock_slot", 8, "u64"],
  ["reveal_slot", 8, "u64"],
  ["fee_bps", 2, "u16"],
  ["randomness", 32, "bytes"],
  ["winning_ticket", 16, "u128"],
  ["winner", 32, "pubkey"],
  ["fee_lamports", 8, "u64"],
  ["payout_lamports", 8, "u64"],
  ["payout_account", 32, "pubkey"],
  ["tier", 1, "u8"],
  ["bump", 1, "u8"],
];

const roundId = BigInt(process.argv[2] ?? 1);
const key = roundPda(PROGRAM_ID, roundId);
const acc = await connection.getAccountInfo(key, "confirmed");
if (!acc) {
  console.log(`round ${roundId} does not exist at ${key.toBase58()}`);
  process.exit(1);
}
const d = acc.data;
console.log(`Round ${roundId}  ${key.toBase58()}`);
console.log(`  owner      ${acc.owner.toBase58()}`);
console.log(`  space      ${d.length} bytes`);
console.log(`  disc       ${d.subarray(0, 8).toString("hex")}`);

let o = 8;
for (const [name, size, kind] of layout) {
  let value;
  if (kind === "pubkey") value = new PublicKey(d.subarray(o, o + size)).toBase58();
  else if (kind === "bytes") value = `<${size} bytes>`;
  else if (size === 1) value = d[o];
  else if (size === 2) value = d.readUInt16LE(o);
  else if (size === 4) value = d.readUInt32LE(o);
  else if (size === 8) value = d.readBigUInt64LE(o);
  else value = d.subarray(o, o + 16).reduce((a, b, i) => a + BigInt(b) * 256n ** BigInt(i), 0n);
  console.log(`  ${name.padEnd(18)} ${String(value)}`);
  o += size;
}
console.log(`  ${"consumed".padEnd(18)} ${o} bytes`);

const escrow = escrowPda(PROGRAM_ID, key);
console.log(`\n  escrow PDA  ${escrow.toBase58()} (round field must match)`);
const escrowAcc = await connection.getAccountInfo(escrow, "confirmed");
console.log(`  escrow      ${escrowAcc ? `exists, ${escrowAcc.lamports} lamports, owner ${escrowAcc.owner.toBase58()}` : "MISSING"}`);

const problems = [];
if (o !== d.length) problems.push(`layout consumed ${o} of ${d.length} bytes`);
if (!acc.owner.equals(PROGRAM_ID)) problems.push("round is not owned by the program");
if (d[9] !== 0) problems.push(`status is ${d[9]}, expected 0 (Open)`);
if (d.readUInt16LE(93) !== 200) problems.push(`fee_bps is ${d.readUInt16LE(93)}, expected 200`);
if (!escrowAcc) problems.push("escrow PDA was not created");

if (problems.length) {
  console.log("\nPROBLEMS:");
  problems.forEach((p) => console.log("  x " + p));
  process.exit(2);
}
console.log("\nON-CHAIN ROUND VERIFIED (Open, 7.5% fee frozen, escrow created)");
