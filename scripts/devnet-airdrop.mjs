// Tops up the operator wallet via the devnet JSON-RPC requestAirdrop
// (rate limited: retry with backoff). Never prints a secret.
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import fs from "node:fs";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("operator-devnet.key.json", "utf8"))),
);
const c = new Connection(RPC, "confirmed");
const target = Number(process.argv[2] ?? 2) * LAMPORTS_PER_SOL;

const bal = await c.getBalance(payer.publicKey);
console.log(`wallet: ${payer.publicKey.toBase58()} balance ${(bal / 1e9).toFixed(4)} SOL`);
if (bal >= target) {
  console.log("already funded");
  process.exit(0);
}
for (let i = 1; i <= 8; i++) {
  try {
    const sig = await c.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
    const latest = await c.getLatestBlockhash();
    await c.confirmTransaction({ signature: sig, ...latest }, "confirmed");
    const now = await c.getBalance(payer.publicKey);
    console.log(`airdrop ${i} ok -> ${(now / 1e9).toFixed(4)} SOL`);
    if (now >= target) process.exit(0);
  } catch (e) {
    console.log(`airdrop ${i} failed: ${String(e.message).slice(0, 80)}`);
    await new Promise((r) => setTimeout(r, 15000 * i));
  }
}
const final = await c.getBalance(payer.publicKey);
console.log(`final: ${(final / 1e9).toFixed(4)} SOL`);
process.exit(final >= target ? 0 : 1);
