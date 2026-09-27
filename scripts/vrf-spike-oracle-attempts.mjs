// Looks for the oracle's ProvideRandomness attempts against the spike program:
// any failed tx touching the queue that references the spike callback is
// evidence the oracle TRIED and the callback rejected it (identity mismatch).
import { Connection, PublicKey } from "@solana/web3.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(process.argv[2] ?? "HRdbK1k8XXQCcJDfeT8ihL4f7eLkiBKkEWmGJ95GaiRC");
const QUEUE = new PublicKey("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");
const [state] = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);
const [programIdentity] = PublicKey.findProgramAddressSync([Buffer.from("identity")], PROGRAM_ID);
const c = new Connection(RPC, "confirmed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(fn, tries = 10) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1200 * (i + 1));
    }
  }
}

console.log(`spike:        ${PROGRAM_ID.toBase58()}`);
console.log(`state:        ${state.toBase58()}`);
console.log(`prog identity:${programIdentity.toBase58()}`);
console.log(`\n--- recent sigs touching the spike program ---`);
const sigs = await rpc(() => c.getSignaturesForAddress(PROGRAM_ID, { limit: 20 }));
for (const s of sigs) {
  console.log(`${s.signature} slot=${s.slot} err=${s.err ? JSON.stringify(s.err).slice(0, 80) : "no"}`);
}
console.log(`\n--- recent sigs touching the program identity PDA ---`);
const sigs2 = await rpc(() => c.getSignaturesForAddress(programIdentity, { limit: 20 }));
for (const s of sigs2) {
  console.log(`${s.signature} slot=${s.slot} err=${s.err ? JSON.stringify(s.err).slice(0, 80) : "no"}`);
}
console.log(`\n--- recent FAILED queue txs (oracle retries) ---`);
const qsigs = await rpc(() => c.getSignaturesForAddress(QUEUE, { limit: 30 }));
let shown = 0;
for (const s of qsigs) {
  if (!s.err || shown >= 4) continue;
  const tx = await rpc(() => c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })).catch(() => null);
  if (!tx) continue;
  const logs = (tx.meta.logMessages ?? []).join("\n");
  if (!logs.includes(PROGRAM_ID.toBase58()) && !logs.includes(programIdentity.toBase58()) && !logs.includes(state.toBase58())) continue;
  shown++;
  console.log(`${s.signature} slot=${s.slot}`);
  for (const l of tx.meta.logMessages) console.log(`  | ${l}`);
  await sleep(300);
}
if (shown === 0) console.log("(none referencing the spike program)");
