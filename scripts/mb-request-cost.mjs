// Cost + payer analysis of REAL devnet VRF requests.
// For each recent RequestRandomness tx: who paid, how much, which accounts were
// created, and what the queue balance trend looks like. Read-only.
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const QUEUE = new PublicKey("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");
const VRF_PROGRAM = "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz";

const c = new Connection(RPC, "confirmed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sol = (l) => `${(l / LAMPORTS_PER_SOL).toFixed(9)} SOL`;

async function rpc(fn, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1000 * (i + 1));
    }
  }
}

const sigs = await rpc(() => c.getSignaturesForAddress(QUEUE, { limit: 40 }));
let shown = 0;
for (const s of sigs) {
  if (shown >= 2) break;
  const tx = await rpc(() => c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }));
  if (!tx) continue;
  const logs = tx.meta?.logMessages ?? [];
  if (!logs.some((l) => l.includes("Instruction: RequestRandomness"))) continue;
  if (tx.meta.err) continue;
  shown++;

  const keys = tx.transaction.message.accountKeys.map((k) =>
    typeof k === "string" ? k : typeof k.toBase58 === "function" ? k.toBase58() : k.pubkey.toBase58(),
  );
  console.log(`\n===== REQUEST TX ${s.signature}`);
  console.log(`  slot=${tx.slot} cu=${tx.meta.computeUnitsConsumed} fee=${tx.meta.fee} lamports (${sol(tx.meta.fee)})`);
  console.log(`  fee payer: ${keys[0]}`);
  console.log(`  outer programs: ${[...new Set(tx.transaction.message.instructions.map((i) => keys[i.programIdIndex]))].join(", ")}`);
  console.log("  --- logs ---");
  for (const l of logs) console.log(`    ${l}`);
  console.log("  --- lamport movements ---");
  for (let i = 0; i < keys.length; i++) {
    const d = tx.meta.postBalances[i] - tx.meta.preBalances[i];
    if (d !== 0) console.log(`    ${keys[i]}: ${sol(tx.meta.preBalances[i])} -> ${sol(tx.meta.postBalances[i])} (${d > 0 ? "+" : ""}${(d / LAMPORTS_PER_SOL).toFixed(9)})`);
  }
  console.log("  --- accounts created by the request ---");
  for (let i = 0; i < keys.length; i++) {
    if (tx.meta.postBalances[i] > 0 && tx.meta.preBalances[i] === 0) {
      const info = await rpc(() => c.getAccountInfo(new PublicKey(keys[i]), { commitment: "confirmed" }));
      const owner = info?.owner?.toBase58() ?? "n/a";
      console.log(`    ${keys[i]}: lamports=${tx.meta.postBalances[i]} (${sol(tx.meta.postBalances[i])}) len=${info?.data?.length ?? "?"} owner=${owner}`);
    }
  }
  await sleep(400);
}

console.log("\n===== queue funding trend");
const q = await rpc(() => c.getAccountInfo(QUEUE, { commitment: "confirmed" }));
const perFulfillment = 500000;
console.log(`  queue balance now: ${q.lamports} lamports (${sol(q.lamports)})`);
console.log(`  cost paid BY THE QUEUE per fulfillment: ${perFulfillment} lamports (${sol(perFulfillment)})`);
console.log(`  => remaining funded fulfillments at that rate: ~${Math.floor(q.lamports / perFulfillment)}`);
