/**
 * Devnet smoke test — proves a REAL devnet transaction end to end.
 *
 *   node scripts/devnet-smoke.mjs
 *
 * It sends a tiny (0.001 devnet SOL) System Program transfer from the
 * configured operator/escrow wallet, waits for `confirmed`, then re-reads the
 * transaction from the cluster and verifies that the transfer really happened.
 * It prints the signature and the devnet Explorer link — or a precise reason
 * why it could not run (most often: the escrow has no devnet SOL yet).
 *
 * The signing key comes from OPERATOR_KEYPAIR in the environment only.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const AMOUNT = 1_000_000n; // 0.001 devnet SOL
const keyJson = process.env.OPERATOR_KEYPAIR;

if (!keyJson) {
  console.error("OPERATOR_KEYPAIR is not set. Generate one with:");
  console.error("  node scripts/generate-operator-keypair.mjs");
  process.exit(1);
}

const operator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(keyJson)));
const connection = new Connection(RPC, "confirmed");
const explorer = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

/** Deterministic collector address — never a key anyone holds. */
// Deterministic collector address derived from a throwaway seed. Nobody holds
// the matching private key — it only exists to receive the smoke-test dust.
const collector = new PublicKey(Uint8Array.from(ed25519.getPublicKey(new Uint8Array(32).fill(0x21))));

console.log(`network:  devnet`);
console.log(`rpc:      ${RPC}`);
console.log(`from:     ${operator.publicKey.toBase58()}`);
console.log(`to:       ${collector.toBase58()}`);
console.log(`amount:   ${AMOUNT} lamports (0.001 devnet SOL)`);

const balance = BigInt(await connection.getBalance(operator.publicKey, "confirmed"));
console.log(`balance:  ${balance} lamports`);
if (balance < AMOUNT + 10_000n) {
  console.error("");
  console.error(`NOT ENOUGH DEVNET SOL — no transaction was sent.`);
  console.error(`Fund this address with the faucet, then run this script again:`);
  console.error(`  https://faucet.solana.com  →  ${operator.publicKey.toBase58()}`);
  process.exit(2);
}

const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
const tx = new Transaction({ feePayer: operator.publicKey, blockhash, lastValidBlockHeight }).add(
  SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: collector, lamports: AMOUNT })
);

const signature = await sendAndConfirmTransaction(connection, tx, [operator], { commitment: "confirmed" });
console.log("");
console.log(`signature: ${signature}`);
console.log(`explorer:  ${explorer(signature)}`);

// Independent verification, exactly like the API does for a deposit.
const parsed = await connection.getParsedTransaction(signature, {
  commitment: "confirmed",
  maxSupportedTransactionVersion: 0,
});
if (!parsed) throw new Error("transaction not found on devnet RPC");
if (parsed.meta?.err) throw new Error(`transaction failed on chain: ${JSON.stringify(parsed.meta.err)}`);

const keys = parsed.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
const transfer = parsed.transaction.message.instructions
  .filter((ix) => "program" in ix && ix.program === "system" && ix.parsed?.type === "transfer")
  .map((ix) => ix.parsed.info)
  .find((info) => info.destination === collector.toBase58() && info.source === operator.publicKey.toBase58());

if (!transfer || BigInt(transfer.lamports) < AMOUNT) {
  throw new Error("verification failed: the expected transfer is not on chain");
}
if (keys[0] !== operator.publicKey.toBase58()) {
  throw new Error("verification failed: unexpected fee payer");
}

console.log("");
console.log(`CONFIRMED on devnet: ${transfer.lamports} lamports ${transfer.source} -> ${transfer.destination}`);
console.log(`slot: ${parsed.slot}`);
console.log("");
console.log("✅ real devnet transaction verified");
