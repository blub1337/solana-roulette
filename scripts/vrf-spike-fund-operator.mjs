// Tops the operator wallet up from whichever test-ledger wallet holds the most
// SOL (a throwaway devnet wallet from the E2E ledger). Prints public keys and
// balances only — never a secret. Only runs on devnet.
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import fs from "node:fs";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
if (!/devnet/i.test(RPC)) {
  console.error("refusing to move funds on a non-devnet RPC");
  process.exit(1);
}
const c = new Connection(RPC, "confirmed");

const operator = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("operator-devnet.key.json", "utf8"))),
);
const donors = [];
for (const f of fs.readdirSync("test-ledger")) {
  if (!f.endsWith(".json")) continue;
  const raw = fs.readFileSync(`test-ledger/${f}`, "utf8");
  for (const h of raw.match(/\[\s*\d+(?:\s*,\s*\d+){63}\s*\]/g) ?? []) {
    try {
      donors.push({ file: f, kp: Keypair.fromSecretKey(Uint8Array.from(JSON.parse(h))) });
    } catch {}
  }
}

let best = null;
for (const d of donors) {
  const bal = await c.getBalance(d.kp.publicKey).catch(() => 0);
  if (!best || bal > best.bal) best = { ...d, bal };
}
if (!best) {
  console.error("no donor wallet found");
  process.exit(1);
}
const target = Number(process.argv[2] ?? 200000000);
console.log(`donor:   ${best.kp.publicKey.toBase58()} (${best.file}) ${(best.bal / 1e9).toFixed(4)} SOL`);
console.log(`operator: ${operator.publicKey.toBase58()} ${(await c.getBalance(operator.publicKey) / 1e9).toFixed(4)} SOL`);

const amount = Math.min(target, best.bal - 9000);
if (amount <= 0) {
  console.log("donor has nothing to spare");
  process.exit(0);
}
const ix = SystemProgram.transfer({
  fromPubkey: best.kp.publicKey,
  toPubkey: operator.publicKey,
  lamports: amount,
});
const bh = await c.getLatestBlockhash("confirmed");
const tx = new Transaction({ feePayer: best.kp.publicKey, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }).add(ix);
const sig = await c.sendTransaction(tx, [best.kp], { maxRetries: 5 });
await c.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
console.log(`sent ${(amount / 1e9).toFixed(4)} SOL -> tx ${sig}`);
console.log(`operator now: ${(await c.getBalance(operator.publicKey) / 1e9).toFixed(4)} SOL`);
void TransactionInstruction;
void LAMPORTS_PER_SOL;
