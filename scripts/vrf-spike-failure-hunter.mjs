// Classify the failing ProvideRandomness attempts: whose requests are they,
// which identity PDA do they pass, and does ANY consumer on devnet currently
// get a successful legacy-identity fulfillment?
import { Connection, PublicKey } from "@solana/web3.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const QUEUE = new PublicKey("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");
const GLOBAL_IDENTITY = "9irBy75QS2BN81FUgXuHcjqceJJRuc9oDkAe8TKVvvAw";
const SPIKE = "HRdbK1k8XXQCcJDfeT8ihL4f7eLkiBKkEWmGJ95GaiRC";
const SPIKE_IDENTITY = "7iNjk7DGkugXn2cmEQz9JWZsZgHM7RUh4N7WB9SRPxp8";

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

const sigs = await rpc(() => c.getSignaturesForAddress(QUEUE, { limit: 40 }));
let stats = { fail: 0, ok: 0, failRefsSpike: 0, failRefsGlobal: 0 };
const sample = [];
for (const s of sigs) {
  const tx = await rpc(() => c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })).catch(() => null);
  if (!tx) continue;
  const logs = tx.meta.logMessages ?? [];
  const isProvide = logs.some((l) => l.includes("ProvideRandomness")) || (!s.err && logs.some((l) => l.includes("ConsumeRandomness")));
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey?.toBase58?.() ?? String(k));
  const joined = keys.join(",") + "|" + logs.join("\n");
  if (s.err) {
    stats.fail++;
    if (joined.includes(SPIKE) || joined.includes(SPIKE_IDENTITY)) {
      stats.failRefsSpike++;
      sample.push({ sig: s.signature, slot: s.slot, err: s.err, logs: logs.slice(0, 10), keys: keys.slice(0, 10) });
    }
    if (joined.includes(GLOBAL_IDENTITY)) stats.failRefsGlobal++;
  } else if (isProvide) {
    stats.ok++;
  }
  await sleep(250);
}
console.log("stats:", JSON.stringify(stats));
for (const s of sample.slice(0, 3)) {
  console.log(`\n=== failed tx ${s.sig} slot=${s.slot}`);
  console.log("keys:", s.keys.join(", "));
  for (const l of s.logs) console.log("  |", l);
}
