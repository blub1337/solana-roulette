/**
 * Verify a settlement transaction directly on the devnet RPC: who was debited,
 * who was credited, the exact lamport amounts and the resulting round state.
 *
 *   npx tsx scripts/verify-settlement-tx.ts <signature> [roundId]
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { getRoundPda } from "../packages/verification/src/index.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.ROULETTE_PROGRAM_ID || "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos"
);
const connection = new Connection(RPC, "confirmed");
const S = ["OPEN", "FULL", "LOCKED", "RANDOMNESS_PENDING", "SETTLING", "COMPLETED", "CANCELLED"];

async function main() {
  const sig = process.argv[2];
  const roundId = process.argv[3] ? BigInt(process.argv[3]) : null;
  const tx = await connection.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx) { console.log("transaction not found"); process.exit(1); }
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());

  console.log(`signature ${sig}`);
  console.log(`explorer  https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  console.log(`slot      ${tx.slot}`);
  console.log(`error     ${tx.meta?.err ? JSON.stringify(tx.meta.err) : "none"}`);
  console.log(`fee       ${tx.meta?.fee} lamports (payer ${keys[0]})\n`);

  const pre = tx.meta?.preBalances ?? [];
  const post = tx.meta?.postBalances ?? [];
  console.log("balance changes:");
  for (let i = 0; i < post.length; i++) {
    const d = post[i] - (pre[i] ?? 0);
    if (d === 0) continue;
    const label =
      keys[i] === PROGRAM_ID.toBase58() ? " (program)" : "";
    console.log(`  ${keys[i]}${label}`);
    console.log(`     ${pre[i]} -> ${post[i]}   ${d > 0 ? "+" : ""}${d}`);
  }

  if (roundId !== null) {
    const [rk] = getRoundPda(PROGRAM_ID, roundId);
    const d = (await connection.getAccountInfo(rk, "confirmed"))!.data;
    const winner = new PublicKey(d.subarray(143, 175)).toBase58();
    const fee = d.readBigUInt64LE(175);
    const payout = d.readBigUInt64LE(183);
    const pot = d.readBigUInt64LE(49);
    const escrow = new PublicKey(d.subarray(17, 49)).toBase58();
    const escrowAcc = await connection.getAccountInfo(new PublicKey(escrow), "confirmed");
    console.log(`\nround ${roundId} on chain now:`);
    console.log(`  status    ${S[d[16]]} (code ${d[16]})`);
    console.log(`  pot       ${pot}`);
    console.log(`  winner    ${winner}`);
    console.log(`  payout    ${payout}  (${(Number(payout) / Number(pot) * 100).toFixed(2)}% of pot)`);
    console.log(`  fee       ${fee}  (${(Number(fee) / Number(pot) * 100).toFixed(2)}% of pot)`);
    console.log(`  escrow    ${escrowAcc!.lamports} lamports left`);
    console.log(`  conserved payout + fee == pot: ${payout + fee === pot}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
