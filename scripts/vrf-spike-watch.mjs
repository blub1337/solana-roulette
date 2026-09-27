// Watches the spike state PDA for the REAL oracle fulfillment and, when it
// lands, dumps the complete evidence: request tx, fulfillment tx, CU, cost,
// identity signer check and on-chain state. Exits 0 only on real fulfillment.
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const VRF_PROGRAM = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const GLOBAL_IDENTITY = new PublicKey("9irBy75QS2BN81FUgXuHcjqceJJRuc9oDkAe8TKVvvAw");
const PROGRAM_ID = new PublicKey(process.argv[2] ?? "HRdbK1k8XXQCcJDfeT8ihL4f7eLkiBKkEWmGJ95GaiRC");
const REQUEST_TX = process.argv[3] ?? "";
const TIMEOUT_MS = Number(process.argv[4] ?? 180000);

const [state] = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);
const c = new Connection(RPC, "confirmed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(fn, tries = 12) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}

function decodeState(buf) {
  return {
    request_count: buf.readUInt32LE(8),
    fulfill_count: buf.readUInt32LE(12),
    client_seed: buf.readUInt8(16),
    last_lane: buf.readUInt8(17),
    roll: buf.readUInt8(18),
    fulfilled: buf.readUInt8(19),
    randomness: buf.subarray(20, 52).toString("hex"),
    bump: buf.readUInt8(52),
  };
}

console.log(`watching ${state.toBase58()} for fulfillment (timeout ${TIMEOUT_MS}ms)`);
const seen = new Set(REQUEST_TX ? [REQUEST_TX] : []);
const deadline = Date.now() + TIMEOUT_MS;
let found = null;

while (!found && Date.now() < deadline) {
  const sigs = await rpc(() => c.getSignaturesForAddress(state, { limit: 20 })).catch(() => []);
  for (const s of sigs) {
    if (seen.has(s.signature)) continue;
    seen.add(s.signature);
    if (s.err) continue;
    const tx = await rpc(() => c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })).catch(() => null);
    if (!tx) continue;
    if ((tx.meta?.logMessages ?? []).some((l) => l.includes("VrfSpikeConsume"))) {
      found = { sig: s.signature, tx };
      break;
    }
  }
  if (!found) await sleep(2500);
}

if (!found) {
  console.log("NO FULFILLMENT observed within the timeout");
  process.exit(2);
}

console.log(`\n=== REAL FULFILLMENT ===`);
console.log(`fulfillment tx: ${found.sig}`);
console.log(`slot: ${found.tx.slot}, total cu: ${found.tx.meta.computeUnitsConsumed}, fee: ${found.tx.meta.fee} lamports (${(found.tx.meta.fee / LAMPORTS_PER_SOL)} SOL)`);
console.log(`fee payer: ${found.tx.transaction.message.accountKeys[0].pubkey?.toBase58?.() ?? found.tx.transaction.message.accountKeys[0]}`);
console.log("--- logs ---");
for (const l of found.tx.meta.logMessages) console.log(`  | ${l}`);

const keys = found.tx.transaction.message.accountKeys.map((k) =>
  typeof k === "string" ? k : typeof k.toBase58 === "function" ? k.toBase58() : k.pubkey.toBase58(),
);
console.log("--- callback CPI ---");
for (const inner of found.tx.meta.innerInstructions ?? []) {
  for (const i of inner.instructions) {
    const pid = typeof i.programId?.toBase58 === "function" ? i.programId.toBase58() : keys[i.programIdIndex];
    if (pid !== PROGRAM_ID.toBase58()) continue;
    const a0 = i.accounts?.[0];
    const addr = typeof a0 === "number" ? keys[a0] : a0?.pubkey?.toBase58?.() ?? "?";
    const isSigner = typeof a0 === "number" ? null : a0.isSigner;
    console.log(`  program: ${pid}`);
    console.log(`  account[0]: ${addr} isSigner=${isSigner} (expected ${GLOBAL_IDENTITY.toBase58()})`);
    console.log(`  MATCH: ${addr === GLOBAL_IDENTITY.toBase58() && isSigner === true}`);
    console.log(`  data: ${Buffer.from(i.data).toString("hex")}`);
  }
}
console.log("--- per-program CU ---");
for (const l of found.tx.meta.logMessages) {
  const m = l.match(/^Program (\S+) consumed (\d+) of (\d+) compute units/);
  if (m) console.log(`  ${m[1]}: ${m[2]} CU (budget ${m[3]})`);
}
const acc = await rpc(() => c.getAccountInfo(state, { commitment: "confirmed" }));
console.log("--- on-chain state after ---");
console.log(JSON.stringify(decodeState(acc.data), null, 2));
