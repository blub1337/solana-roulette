// Forensic inspection of REAL devnet VRF transactions on DEFAULT_QUEUE.
// Answers: which identity PDA the callback validates, who pays, what the cost
// is, how many CU each side burns, and what error 0x1 failing spammers hit.
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const QUEUE = new PublicKey("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");
const GLOBAL_IDENTITY = "9irBy75QS2BN81FUgXuHcjqceJJRuc9oDkAe8TKVvvAw";

const c = new Connection(RPC, "confirmed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lamports(x) {
  return `${(x / LAMPORTS_PER_SOL).toFixed(9)} SOL`;
}

async function inspect(sig, label) {
  console.log(`\n================ ${label}: ${sig}`);
  const tx = await c.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) {
    console.log("  (tx unavailable)");
    return;
  }
  console.log(`  slot=${tx.slot}  fee=${lamports(tx.meta.fee)}  cu=${tx.meta.computeUnitsConsumed}`);
  console.log(`  err=${JSON.stringify(tx.meta.err)}`);
  console.log("  --- logs ---");
  for (const l of tx.meta.logMessages ?? []) console.log(`    ${l}`);

  // Per-invocation CU from the top-level log pairs.
  console.log("  --- per-program CU ---");
  const logs = tx.meta.logMessages ?? [];
  for (let i = 0; i < logs.length; i++) {
    const m = logs[i].match(/^Program (\S+) consumed (\d+) of (\d+) compute units/);
    if (m) console.log(`    ${m[1]} used ${m[2]} CU (budget ${m[3]})`);
  }

  // CPI invocations: who called whom, with which accounts.
  console.log("  --- CPI structure ---");
  const keys = tx.transaction.message.accountKeys.map((k) =>
    typeof k === "string" ? k : typeof k.toBase58 === "function" ? k.toBase58() : k.pubkey.toBase58(),
  );
  for (const inner of tx.meta.innerInstructions ?? []) {
    console.log(`    inner ix #${inner.index}:`);
    for (const ix of inner.instructions) {
      const pid =
        typeof ix.programId?.toBase58 === "function"
          ? ix.programId.toBase58()
          : keys[ix.programIdIndex];
      if (pid !== "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz") {
        console.log(`      -> program ${pid}`);
        ix.accounts.forEach((a, i) => {
          const idx = a === undefined ? "?" : a;
          const p = typeof idx === "number" ? keys[idx] : "undef";
          const isId = p === GLOBAL_IDENTITY ? "  <-- GLOBAL VRF_PROGRAM_IDENTITY" : "";
          console.log(`         [${i}] signer=${a?.isSigner ?? "?"} writable=${a?.isWritable ?? "?"} key=${p}${isId}`);
        });
        // Borsh dump of the ix data (callback discriminator + 32-byte randomness).
        const hex = Buffer.from(ix.data).toString("hex");
        console.log(`         data=${hex.slice(0, 160)}${hex.length > 160 ? "…" : ""}`);
        if (hex.length >= 8 + 64) {
          console.log(`         disc=${hex.slice(0, 16)}  arg0_32bytes=${hex.slice(16, 80)}`);
        }
      }
    }
  }

  // Who paid: the fee payer and any lamport movements.
  console.log("  --- balance changes (non-zero) ---");
  for (const { accountIndex, preBalances, postBalances } of [
    { accountIndex: tx.transaction.message.accountKeys.map((_, i) => i), preBalances: tx.meta.preBalances, postBalances: tx.meta.postBalances },
  ]) {
    void accountIndex;
    for (let i = 0; i < preBalances.length; i++) {
      const d = postBalances[i] - preBalances[i];
      if (d !== 0) {
        console.log(`    ${keys[i]}: ${lamports(preBalances[i])} -> ${lamports(postBalances[i])} (${d > 0 ? "+" : ""}${(d / LAMPORTS_PER_SOL).toFixed(9)})`);
      }
    }
  }
  console.log(`  fee payer: ${keys[0]}`);
  return tx;
}

const sigs = await c.getSignaturesForAddress(QUEUE, { limit: 40 });
let done = { ok: 0, fail: 0 };
for (const s of sigs) {
  if (done.ok >= 1 && done.fail >= 1) break;
  const tx = await c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) continue;
  const logs = tx.meta.logMessages ?? [];
  const isFulfill = logs.some((l) => l.includes("VRF_FULFILLED") || (l.includes("Instruction: ProvideRandomness")));
  if (isFulfill && done.ok === 0) {
    await inspect(s.signature, "FULFILLMENT");
    done.ok = 1;
  } else if (s.err && done.fail === 0) {
    await inspect(s.signature, "FAILURE (err)");
    done.fail = 1;
  }
  await sleep(300);
}

console.log("\n=== identity account check ===");
for (const id of [GLOBAL_IDENTITY]) {
  const info = await c.getAccountInfo(new PublicKey(id), { commitment: "confirmed" });
  console.log(`${id}: ${info ? `exists lamports=${info.lamports} owner=${info.owner.toBase58()}` : "DOES NOT EXIST"}`);
}
