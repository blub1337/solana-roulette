// Phase 2 pre-check: is the devnet DEFAULT_QUEUE actually being used?
// Reads recent signatures on the queue, classifies request vs fulfillment txs,
// measures the cost of a request (rent for the request account) and reports
// fulfillment latency when both sides are visible. Read-only.
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const QUEUE = new PublicKey("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");
const VRF_PROGRAM = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");

const c = new Connection(RPC, "confirmed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`queue: ${QUEUE.toBase58()}`);
const qi = await c.getAccountInfo(QUEUE, { commitment: "confirmed" });
console.log(`queue lamports: ${qi.lamports} (${(qi.lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL), data ${qi.data.length} bytes`);

console.log("\n--- recent signatures on the queue ---");
const sigs = await c.getSignaturesForAddress(QUEUE, { limit: 25 });
if (sigs.length === 0) {
  console.log("NO transactions on the queue at all.");
}
const now = Date.now();
for (const s of sigs) {
  const ageS = Math.round((now - (s.blockTime ?? 0) * 1000) / 1000);
  console.log(
    `${s.signature}  slot=${s.slot}  age=${ageS}s  err=${s.err ? "YES" : "no"}  conf=${s.confirmationStatus}`,
  );
}

console.log("\n--- classify up to 8 of them ---");
for (const s of sigs.slice(0, 8)) {
  let tx;
  try {
    tx = await c.getTransaction(s.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
  } catch {
    console.log(`${s.signature.slice(0, 12)}.. could not fetch tx`);
    continue;
  }
  if (!tx) {
    console.log(`${s.signature.slice(0, 12)}.. tx not available (pruned?)`);
    continue;
  }
  const ixNames = [];
  for (const m of tx.meta.innerInstructions ?? []) {
    void m;
  }
  const logs = tx.meta.logMessages ?? [];
  let kind = "unknown";
  if (logs.some((l) => l.includes("RequestRandomness") || l.startsWith("Program log: Requesting randomness"))) kind = "REQUEST?";
  if (logs.some((l) => l.includes("ProvideRandomness"))) kind = "FULFILL(ProvideRandomness)";
  if (logs.some((l) => l.includes("consume_randomness") || l.includes("ConsumeRandomness"))) kind += " + CALLBACK";
  if (s.err) kind += " [FAILED]";
  const fee = tx.meta.fee / LAMPORTS_PER_SOL;
  console.log(`${s.signature}  kind=${kind}  fee=${fee.toFixed(0e-9 * 1e9) === "0" ? fee : fee.toFixed(0.000000001)} SOL cu=${tx.meta.computeUnitsConsumed ?? "n/a"}`);
  const interesting = logs.filter((l) => /randomness|Provide|Request|consume|vrf/i.test(l)).slice(0, 6);
  for (const l of interesting) console.log(`      | ${l}`);
  await sleep(400);
}
