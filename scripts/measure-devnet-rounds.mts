/**
 * READ-ONLY devnet measurement for docs/DEVNET_LEGACY_STATE.md.
 *
 * Dumps every round account the counter says exists, plus the escrow balance,
 * so the documented numbers are measured rather than remembered. This script
 * never signs and never sends a transaction.
 *
 *   npx tsx scripts/measure-devnet-rounds.mts
 */
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  decodeGlobalConfig,
  decodeRound,
  getEscrowPda,
  getGlobalConfigPda,
  getRoundPda,
} from "@solana-roulette/verification";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_ROULETTE_PROGRAM_ID ??
    "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos"
);

const connection = new Connection(RPC, "confirmed");
const lamports = (n: bigint) => Number(n) / LAMPORTS_PER_SOL;

async function main(): Promise<void> {
  const cfg = await connection.getAccountInfo(getGlobalConfigPda(PROGRAM_ID)[0]);
  if (!cfg) throw new Error("GlobalConfig not found on devnet");
  const roundCounter = decodeGlobalConfig(cfg.data).roundCounter;
  console.log(`program   ${PROGRAM_ID.toBase58()}`);
  console.log(`rpc       ${RPC}`);
  console.log(`counter   ${roundCounter}`);
  console.log("");

  const ids: bigint[] = [];
  for (let id = 1n; id <= roundCounter; id++) ids.push(id);

  const rows: Array<Record<string, string | number>> = [];
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const keys = chunk.map((id) => getRoundPda(PROGRAM_ID, id)[0]);
    const infos = await connection.getMultipleAccountsInfo(keys);
    for (const [idx, id] of chunk.entries()) {
      const info = infos[idx];
      if (!info?.data) continue;
      const r = decodeRound(info.data);
      const escrow = await connection.getBalance(getEscrowPda(PROGRAM_ID, id)[0]);
      // `escrow - pot` is only meaningful while the pot is still escrowed.
      // On a COMPLETED round the pot has already been paid out, so escrow
      // correctly sits at rent-only and the subtraction would read negative.
      const holds = r.status !== "COMPLETED" && r.status !== "CANCELLED";
      rows.push({
        id: id.toString(),
        status: r.status,
        tier: r.tier,
        potSol: lamports(r.pot).toFixed(9),
        escrowSol: (escrow / LAMPORTS_PER_SOL).toFixed(9),
        holdsPot: holds ? "yes" : "no",
        escrowMinusPot: holds ? ((escrow - Number(r.pot)) / LAMPORTS_PER_SOL).toFixed(9) : "n/a",
        participants: r.participantCount,
        winner: r.winner.toBase58() === PublicKey.default.toBase58() ? "-" : "set",
        lockSlot: r.lockSlot?.toString() ?? "-",
        revealSlot: r.revealSlot?.toString() ?? "-",
        randomness: r.randomness?.some((b) => b !== 0) ? "set" : "zero",
      });
    }
    if (i + 20 < ids.length) await new Promise((r) => setTimeout(r, 150));
  }

  console.log(
    [
      "id",
      "status",
      "tier",
      "pot",
      "escrow",
      "holdsPot",
      "escrow-pot",
      "parts",
      "winner",
      "lockSlot",
      "revealSlot",
      "rnd",
    ].join(" | ")
  );
  for (const r of rows) {
    console.log(
      [
        r.id,
        r.status,
        r.tier,
        r.potSol,
        r.escrowSol,
        r.holdsPot,
        r.escrowMinusPot,
        r.participants,
        r.winner,
        r.lockSlot,
        r.revealSlot,
        r.randomness,
      ].join(" | ")
    );
  }

  const terminal = rows.filter((r) => r.status === "COMPLETED" || r.status === "CANCELLED");
  console.log("");
  console.log(`terminal (COMPLETED/CANCELLED): ${terminal.length} of ${rows.length}`);
  const open = rows.filter(
    (r) => r.status === "OPEN" || r.status === "FULL" || r.status === "RANDOMNESS_PENDING"
  );
  console.log(`non-terminal still holding pot: ${open.length}`);
  for (const r of open) {
    if (r.potSol === "0.000000000") continue; // empty escrow: just rent, not stranded
    console.log(`  round ${r.id} ${r.status} pot=${r.potSol} escrow-pot=${r.escrowMinusPot}`);
  }
}

main().catch((e) => {
  console.error("measure failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
