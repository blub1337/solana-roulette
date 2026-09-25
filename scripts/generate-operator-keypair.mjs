/**
 * Generate the DEVNET operator keypair that signs payouts.
 *
 * The secret is printed ONCE, for you to paste into Settings → Environment as
 * OPERATOR_KEYPAIR. It is never written to the repository, never sent to the
 * browser and never logged. Use a different key for mainnet.
 *
 *   node scripts/generate-operator-keypair.mjs
 *
 * After setting the key, the same address doubles as the deposit escrow, so
 * fund THAT address with devnet SOL (https://faucet.solana.com) to let the
 * platform pay winners.
 */
import { Keypair } from "@solana/web3.js";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

const keypair = Keypair.generate();
const address = keypair.publicKey.toBase58();

console.log("DEVNET operator keypair generated.");
console.log("");
console.log("1) Add this to Settings → Environment (secret — keep it server-side):");
console.log(`   OPERATOR_KEYPAIR=${JSON.stringify(Array.from(keypair.secretKey))}`);
console.log("");
console.log("2) Optional: make the escrow explicit (defaults to the address below):");
console.log(`   DEPOSIT_ESCROW_WALLET=${address}`);
console.log("");
console.log("3) Fund the platform so it can pay winners (2 devnet SOL is plenty):");
console.log(`   https://faucet.solana.com  →  ${address}`);
console.log("");
console.log(`   Escrow / payout address: ${address}`);
console.log(`   Explorer: https://explorer.solana.com/address/${address}?cluster=devnet`);
console.log("");
console.log(`   A full 1-SOL round needs ${LAMPORTS_PER_SOL.toString()} lamports in escrow to pay the winner.`);
