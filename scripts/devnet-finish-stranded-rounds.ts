/**
 * Settle + pay any devnet round left stranded at RANDOMNESS_PENDING by an
 * interrupted E2E run, so player funds are not left locked in escrow.
 *
 *   npx tsx scripts/devnet-finish-stranded-rounds.ts
 *
 * Uses the STRANGER key, not the operator — which is itself a second
 * demonstration that payout does not depend on the operator. Only rounds whose
 * reveal_slot has passed are touched; anything still pending is left alone.
 */
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { existsSync, readFileSync } from "node:fs";
import {
  configPda,
  roundPda,
  escrowPda,
  participantPda,
  settleRoundIx,
  payWinnersIx,
} from "../packages/sdk/src/index.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM = new PublicKey(
  process.env.ROULETTE_PROGRAM_ID || "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos"
);
const TREASURY = new PublicKey("6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR");
const RENT_FLOOR = 650_240;

const connection = new Connection(RPC, "confirmed");

async function main() {
  const stranger = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync("test-ledger/e2e-stranger.json", "utf8")))
  );
  const wallets = JSON.parse(readFileSync("test-ledger/e2e-wallets.json", "utf8")) as {
    wallets: { label: string; pubkey: string }[];
  };
  const cfg = (await connection.getAccountInfo(configPda(PROGRAM), "confirmed"))!.data;
  const counter = Number(cfg.readBigUInt64LE(106));
  const operator = new PublicKey(cfg.subarray(8, 40)).toBase58();
  console.log(`counter ${counter} · operator ${operator} · settling as stranger ${stranger.publicKey.toBase58()}`);

  const slot = await connection.getSlot("confirmed");
  let touched = 0;
  const unrecoverable: string[] = [];

  for (let id = 1n; id <= BigInt(counter); id++) {
    const acc = await connection.getAccountInfo(roundPda(PROGRAM, id), "confirmed");
    if (!acc || acc.data.length !== 257) continue;
    const r = acc.data;
    const status = r[16]!;
    if (status !== 3) continue; // RANDOMNESS_PENDING only
    const revealSlot = r.readBigUInt64LE(85);
    if (BigInt(slot) < revealSlot) {
      console.log(`round ${id}: RANDOMNESS_PENDING, reveal_slot ${revealSlot} not reached yet — skipped`);
      continue;
    }
    const winner = new PublicKey(r.subarray(143, 175));
    const escrow = escrowPda(PROGRAM, roundPda(PROGRAM, id));

    const parts: { pda: PublicKey }[] = [];
    for (const w of wallets.wallets) {
      const pda = participantPda(PROGRAM, roundPda(PROGRAM, id), new PublicKey(w.pubkey));
      if (await connection.getAccountInfo(pda, "confirmed")) parts.push({ pda });
    }
    const count = r.readUInt32LE(73);
    if (parts.length !== count) {
      console.log(`round ${id}: only ${parts.length}/${count} participants resolvable — skipped`);
      continue;
    }

    if (winner.equals(PublicKey.default)) {
      // Settle can legitimately fail: once `reveal_slot` falls out of the
      // 150-slot SlotHashes retention window the entropy is gone and the draw
      // is unrecoverable. That is a devnet-adapter property, not a bug in the
      // permissionless change — record it and move on rather than aborting the
      // remaining rounds.
      try {
        const sig = await send(
          settleRoundIx(PROGRAM, stranger.publicKey, id, TREASURY, parts.map((p) => p.pda)),
          stranger,
          "settle"
        );
        const after = (await connection.getAccountInfo(roundPda(PROGRAM, id), "confirmed"))!.data;
        console.log(`round ${id}: settled ${sig} -> winner ${new PublicKey(after.subarray(143, 175)).toBase58()}`);
        touched++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const reason = /RevealBlockhashMissing/.test(msg)
          ? "reveal_slot aged out of the SlotHashes window — UNRECOVERABLE (see report)"
          : msg.split("\n")[0]!.slice(0, 120);
        console.log(`round ${id}: settle FAILED — ${reason}`);
        unrecoverable.push(id.toString());
        continue;
      }
    }
    const cur = (await connection.getAccountInfo(roundPda(PROGRAM, id), "confirmed"))!.data;
    const w = new PublicKey(cur.subarray(143, 175));
    const before = await connection.getBalance(escrow, "confirmed");
    if (before > RENT_FLOOR) {
      try {
        const sig = await send(payWinnersIx(PROGRAM, stranger.publicKey, id, w, TREASURY), stranger, "pay");
        const after = await connection.getBalance(escrow, "confirmed");
        console.log(`round ${id}: paid ${sig} -> escrow ${before} -> ${after}`);
        touched++;
      } catch (e) {
        console.log(`round ${id}: pay FAILED — ${(e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 120)}`);
        unrecoverable.push(id.toString());
      }
    }
  }
  console.log(touched === 0 ? "\nnothing stranded" : `\n${touched} step(s) completed as the non-operator stranger`);
  if (unrecoverable.length) {
    console.log(
      `\nUNRECOVERABLE rounds (pot still in escrow, no on-chain rescue path): ${unrecoverable.join(", ")}`
    );
  }
}

async function send(ix: any, payer: Keypair, label: string): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(ix);
  tx.partialSign(payer);
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
  return sig;
}

main().catch((e) => {
  console.error("failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
