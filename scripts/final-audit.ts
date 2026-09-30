/**
 * Final read-only audit: re-fetch every lifecycle transaction from the DEVNET
 * RPC and print signature, fee payer, status, lamport movement and the
 * resulting on-chain round state. Prints no secrets.
 */
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getEscrowPda, getRoundPda, decodeRound } from "../packages/verification/src/index.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM = new PublicKey("F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos");
const TREASURY = "6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR";
const OPERATOR = "FgEPpAmLLiod4RyBhUcLdvpzPGiBdotoEawyPqyftg1q";

const conn = new Connection(RPC, "confirmed");

const TXS: Array<{ stage: string; sig: string }> = [
  { stage: "create_round (r7)", sig: "dLb4JKAyP2568M7yUfovjoArYBgvEd4T8ZZoQiiR1z1kt1Nv6SMrejbTxXXugiLzyTR7KsfhY4E1d2DzXAUNWUx" },
  { stage: "deposit T1", sig: "2r21YPzd4nb7ZYcTyMiTbbtX8b18uVjwGYhXLvfb9kyDhymv8xyrAtUfmH8ESNcHWV5jUdSvzzQs3vhXGz1Jgekt" },
  { stage: "deposit T2", sig: "mkXoBK718SkyB9XEi1fBfP2sxvcqSmSwWnFtjddbJoFeb1CxMJx3rc5Yb2BYYZ1gSWAn32ReNDHy9QAvZnDn32P" },
  { stage: "deposit T3", sig: "3D1F5CXR2vi4UPXEb8sH5c2rdxgGSC7KZWyYQi2x3kCBxBehu1A8TvNjmCyDDXLEm5DV4H7CA4tK4QQpFKYZW9RH" },
  { stage: "lock_round", sig: "2TsjqnMmPJzyWAmob8wTqG3RHvkLpQp5CPU4bKPzpPzvZD8FAj1EeFJtVf4JFZf2UyYYVsDxr4yLHs7JKNX51NX1" },
  { stage: "settle_round", sig: "5fkNsedyCHYa9V47fc9ekcircB23cGiHtSnAL1W6cCE61oQjeQUMpJmB7wzjzvqVYt43ZcVodxK8cJWwEafoXiUL" },
  { stage: "pay_winners (r7)", sig: "ntTeApvmBowGgQzXcAn1ukZF6q3RuAxYFBZDMNugkj3K4y7KDAvLSY49KxwDeBHTxMSiHJKPXLJxL26ZkDYModP" },
  { stage: "api-driver fill", sig: "57RvtWgWdfy2GQMEwGo4rkhY4PdQKLdJNMuUoa7dPYxWU92XTLV6Atr3teQiLeLvk2NhCLvHfDAa2Z7V3rpSj39k" },
  { stage: "api-driver pay", sig: "4qLntqBdyP2oN4jG5T6SSnLSED2xgraKTDisNcu3r9UPqvffrxM6AEk1MiQVBydbBkrJDdLXzdN9kQVFc9JhRJ6h" },
];

const sol = (n: bigint | number) => `${n} (${(Number(n) / LAMPORTS_PER_SOL).toFixed(9)} SOL)`;

async function main() {
  console.log(`cluster: devnet   slot: ${await conn.getSlot("confirmed")}\n`);

  for (const { stage, sig } of TXS) {
    const tx = await conn.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx) { console.log(`${stage.padEnd(20)} NOT FOUND ON RPC`); continue; }
    const feePayer = tx.transaction.message.accountKeys[0].pubkey.toBase58();
    const lamports = tx.meta?.fee ?? 0;
    const pre = tx.meta?.preBalances ?? [];
    const post = tx.meta?.postBalances ?? [];
    const moved: string[] = [];
    pre.forEach((b, i) => {
      const d = BigInt(post[i] ?? 0) - BigInt(b);
      if (d !== 0n) moved.push(`${tx.transaction.message.accountKeys[i].pubkey.toBase58().slice(0, 6)}… ${d > 0n ? "+" : ""}${d}`);
    });
    console.log(
      `${stage.padEnd(20)} ${tx.meta?.err ? "FAILED " : "OK     "} slot=${tx.slot} payer=${feePayer === OPERATOR ? "operator" : feePayer.slice(0, 8)} fee=${lamports}`,
    );
    console.log(`${" ".repeat(20)} ${moved.join(" | ")}`);
  }

  console.log("\n--- final on-chain round state ---");
  for (const roundId of [1n, 7n, 8n, 9n, 10n]) {
    const [roundKey] = getRoundPda(PROGRAM, roundId);
    const acc = await conn.getAccountInfo(roundKey, "confirmed");
    if (!acc) { console.log(`round ${String(roundId).padStart(2)}  DOES NOT EXIST`); continue; }
    const r = decodeRound(acc.data);
    const [escrowKey] = getEscrowPda(PROGRAM, roundKey);
    const escrowBal = await conn.getBalance(escrowKey, "confirmed");
    console.log(
      `round ${String(roundId).padStart(2)}  status=${r.status.padEnd(20)} pot=${String(r.pot).padStart(10)}  entrants=${r.participantCount}  fee_bps=${r.feeBps}  payout=${r.payoutLamports}  fee=${r.feeLamports}  escrowBal=${escrowBal}`,
    );
    console.log(`${" ".repeat(9)}winner=${r.winner.toBase58()}  ticket=${r.winningTicket}  randomness=${Buffer.from(r.randomness).toString("hex")}`);
  }

  const tre = await conn.getBalance(new PublicKey(TREASURY), "confirmed");
  const op = await conn.getBalance(new PublicKey(OPERATOR), "confirmed");
  console.log(`\ntreasury ${TREASURY}  ${sol(tre)}`);
  console.log(`operator ${OPERATOR}  ${sol(op)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
