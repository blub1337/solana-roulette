// Sends one REAL request against the LIVE spike program (raw send, no
// preflight so provider errors surface as logs), then watches for the real
// fulfillment. Prints everything needed for the report.
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import fs from "node:fs";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const VRF_PROGRAM = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const QUEUE = new PublicKey("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");
const SLOT_HASHES = new PublicKey("SysvarS1otHashes111111111111111111111111111");
const GLOBAL_IDENTITY = new PublicKey("9irBy75QS2BN81FUgXuHcjqceJJRuc9oDkAe8TKVvvAw");
const PROGRAM_ID = new PublicKey("HRdbK1k8XXQCcJDfeT8ihL4f7eLkiBKkEWmGJ95GaiRC");

const c = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("operator-devnet.key.json", "utf8"))),
);
const [state] = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);
const [identity] = PublicKey.findProgramAddressSync([Buffer.from("identity")], PROGRAM_ID);
const disc = (m) => createHash("sha256").update(`global:${m}`).digest().subarray(0, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const seed = Number(process.argv[2] ?? 44);
const lane = Number(process.argv[3] ?? 0);
const WATCH_MS = Number(process.argv[4] ?? 150000);

const balBefore = await c.getBalance(payer.publicKey);
const bh = await c.getLatestBlockhash("finalized");
const ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: identity, isSigner: false, isWritable: false },
    { pubkey: QUEUE, isSigner: false, isWritable: true },
    { pubkey: state, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SLOT_HASHES, isSigner: false, isWritable: false },
    { pubkey: VRF_PROGRAM, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([disc("request_randomness"), Buffer.from([seed, lane])]),
});
const tx = new Transaction({
  feePayer: payer.publicKey,
  blockhash: bh.blockhash,
  lastValidBlockHeight: bh.lastValidBlockHeight,
});
tx.add(ix);
let requestSig;
try {
  requestSig = await c.sendTransaction(tx, [payer], { skipPreflight: false, maxRetries: 10 });
} catch (e) {
  console.log("SEND ERR:", e.message);
  if (e.logs) e.logs.forEach((l) => console.log(" |", l));
  process.exit(1);
}
console.log(`REQUEST_TX ${requestSig}`);
let requestSlot = null;
for (let i = 0; i < 12; i++) {
  await sleep(3000);
  const t = await c.getTransaction(requestSig, { maxSupportedTransactionVersion: 0 }).catch(() => null);
  if (t) {
    requestSlot = t.slot;
    console.log(`request slot ${t.slot} cu ${t.meta.computeUnitsConsumed} fee ${t.meta.fee}`);
    for (const l of t.meta.logMessages) console.log(`  | ${l}`);
    if (t.meta.err) process.exit(1);
    break;
  }
}
const balAfter = await c.getBalance(payer.publicKey);
console.log(`request cost: ${balBefore - balAfter} lamports`);
console.log(`watching up to ${WATCH_MS}ms...`);

const seen = new Set([requestSig]);
const deadline = Date.now() + WATCH_MS;
while (Date.now() < deadline) {
  const sigs = await c.getSignaturesForAddress(state, { limit: 15 }).catch(() => []);
  for (const s of sigs) {
    if (seen.has(s.signature)) continue;
    seen.add(s.signature);
    if (s.err) continue;
    const t = await c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
    if (!t) continue;
    if (!(t.meta.logMessages ?? []).some((l) => l.includes("VrfSpikeConsume"))) continue;
    console.log(`\nFULFILLMENT_TX ${s.signature}`);
    console.log(`slot ${t.slot} (${t.slot - requestSlot} slots after request) cu ${t.meta.computeUnitsConsumed} fee ${t.meta.fee}`);
    for (const l of t.meta.logMessages) console.log(`  | ${l}`);
    const keys = t.transaction.message.accountKeys.map((k) => k.pubkey?.toBase58?.() ?? String(k));
    for (const inner of t.meta.innerInstructions ?? []) {
      for (const i of inner.instructions) {
        const pid = typeof i.programId?.toBase58 === "function" ? i.programId.toBase58() : keys[i.programIdIndex];
        if (pid !== PROGRAM_ID.toBase58()) continue;
        const a0 = i.accounts?.[0];
        const addr = typeof a0 === "number" ? keys[a0] : a0?.pubkey?.toBase58?.() ?? "?";
        const isSigner = typeof a0 === "number" ? null : a0.isSigner;
        console.log(`identity check: account0=${addr} isSigner=${isSigner} expected=${GLOBAL_IDENTITY.toBase58()} MATCH=${addr === GLOBAL_IDENTITY.toBase58() && isSigner === true}`);
      }
    }
    const acc = await c.getAccountInfo(state, { commitment: "confirmed" });
    const st = {
      request_count: acc.data.readUInt32LE(8),
      fulfill_count: acc.data.readUInt32LE(12),
      client_seed: acc.data.readUInt8(16),
      last_lane: acc.data.readUInt8(17),
      roll: acc.data.readUInt8(18),
      fulfilled: acc.data.readUInt8(19),
      randomness: acc.data.subarray(20, 52).toString("hex"),
      bump: acc.data.readUInt8(52),
    };
    console.log(`state: ${JSON.stringify(st)}`);
    process.exit(0);
  }
  await sleep(2500);
}
console.log("NO FULFILLMENT within timeout");
process.exit(2);
