/**
 * Inspect a test wallet's real devnet state: balance, transaction history and
 * whether the Participant PDA for a given round already exists (and who paid
 * its rent).
 */
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { readFileSync, existsSync } from "node:fs";
import { getRoundPda, getParticipantPda } from "../packages/verification/src/index.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.ROULETTE_PROGRAM_ID || "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos"
);
const connection = new Connection(RPC, "confirmed");
async function main() {
  const w = JSON.parse(readFileSync("test-ledger/e2e-wallets.json", "utf8"));
  const roundId = BigInt(process.argv[2] ?? 0);

  for (const t of w.wallets) {
    const kp = new PublicKey(t.pubkey);
    const bal = await connection.getBalance(kp, "confirmed");
    const sigs = await connection.getSignaturesForAddress(kp, { limit: 5 });
    console.log(`\n${t.label} ${t.pubkey}`);
    console.log(`  balance ${bal} lamports (${bal / 1e9} SOL)`);
    console.log(`  recent signatures: ${sigs.length}`);
    for (const s of sigs) console.log(`    slot ${s.slot}  ${s.err ? "ERR" : "ok "}  ${s.signature.slice(0, 24)}…`);
    if (roundId > 0n) {
      const [rk] = getRoundPda(PROGRAM_ID, roundId);
      const [pk] = getParticipantPda(PROGRAM_ID, rk, kp);
      const acc = await connection.getAccountInfo(pk, "confirmed");
      console.log(`  participant(r${roundId}) ${pk.toBase58()}`);
      console.log(`    ${acc ? `EXISTS  ${acc.lamports} lamports, ${acc.data.length} bytes` : "does not exist"}`);
    }
  }

  // Rent maths for a 101-byte Participant account.
  const rent = await connection.getMinimumBalanceForRentExemption(101);
  console.log(`\nrent-exempt minimum for a 101-byte Participant: ${rent} lamports`);
}

main().catch((e) => { console.error(e); process.exit(1); });
