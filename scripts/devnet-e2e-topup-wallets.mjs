/**
 * Fund the throwaway E2E test wallets with real devnet SOL from the operator,
 * so they can deposit into a fresh round. Reuses the same wallets file the
 * lifecycle harness reads. Prints no secrets.
 *
 *   node scripts/devnet-e2e-topup-wallets.mjs
 */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync } from "node:fs";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const connection = new Connection(RPC, "confirmed");
const explorer = (s) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;

const operator = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync("operator-devnet.key.json", "utf8")))
);
const wallets = JSON.parse(readFileSync("test-ledger/e2e-wallets.json", "utf8"));

// deposit + participant rent + wallet rent + tx fee
const PER_WALLET = 302_000_000n;

for (const w of wallets.wallets) {
  const to = new PublicKey(w.pubkey);
  const have = BigInt(await connection.getBalance(to, "confirmed"));
  if (have >= PER_WALLET) {
    console.log(`${w.label} ${w.pubkey}: ${have} lamports — already funded`);
    continue;
  }
  const top = PER_WALLET - have;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: operator.publicKey, blockhash, lastValidBlockHeight }).add(
    SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: to, lamports: top })
  );
  tx.partialSign(operator);
  const sig = await sendAndConfirmTransaction(connection, tx, [operator], { commitment: "confirmed" });
  const after = await connection.getBalance(to, "confirmed");
  console.log(`${w.label} ${w.pubkey}: ${have} -> ${after}  (+${top})`);
  console.log(`  ${sig}`);
  console.log(`  ${explorer(sig)}`);
}
