/**
 * Drive a round to completion using the API's OWN settlement driver.
 *
 * The API driver polls every SETTLEMENT_POLL_MS and advances only the round ids
 * it tracks per tier. Round 1 (tier 0) is the head the Render service holds, so
 * filling it to the tier cap makes the API autonomously lock, settle and pay —
 * no operator action from this script. We watch /api/events at the same time.
 *
 *   npx tsx scripts/devnet-api-driver-e2e.ts <roundId> <depositSol>
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { getRoundPda } from "../packages/verification/src/index.js";
import { depositIx } from "../packages/sdk/src/instructions.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const API = process.env.API_BASE || "https://solana-roulette-api-gd7k.onrender.com";
const PROGRAM_ID = new PublicKey(
  process.env.ROULETTE_PROGRAM_ID || "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos"
);
const TREASURY = new PublicKey("6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR");
const connection = new Connection(RPC, "confirmed");

const roundId = BigInt(process.argv[2] ?? 1);
const depositLamports = BigInt(Math.round(Number(process.argv[3] ?? 0.99) * 1e9));

function decodeRound(buf: Buffer) {
  return {
    id: buf.readBigUInt64LE(8),
    status: buf[16],
    pot: buf.readBigUInt64LE(49),
    count: buf.readUInt32LE(73),
    feeBps: buf.readUInt16LE(93),
    winner: new PublicKey(buf.subarray(143, 175)).toBase58(),
    payout: buf.readBigUInt64LE(183),
    fee: buf.readBigUInt64LE(175),
  };
}
const S = ["OPEN", "FULL", "LOCKED", "RANDOMNESS_PENDING", "SETTLING", "COMPLETED", "CANCELLED"];

async function roundState() {
  const [rk] = getRoundPda(PROGRAM_ID, roundId);
  const acc = await connection.getAccountInfo(rk, "confirmed");
  if (!acc) return null;
  const d = decodeRound(acc.data);
  return { ...d, statusName: S[d.status], escrow: new PublicKey(acc.data.subarray(17, 49)).toBase58() };
}

async function main() {
  const op = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("operator-devnet.key.json", "utf8"))));
  const wallets = JSON.parse(readFileSync("test-ledger/e2e-wallets.json", "utf8"));
  // T1 is the funded depositor (it won 925,000,000 in round 7).
  const t1 = wallets.wallets[0];
  const depositor = Keypair.fromSecretKey(Uint8Array.from(t1.secret));
  const PARTICIPANT_RENT = 1_163_320n;
  const WALLET_RENT = 650_240n;

  const before = await roundState();
  console.log(`round ${roundId}: ${before!.statusName} pot ${before!.pot} entrants ${before!.count}`);
  const need = depositLamports + PARTICIPANT_RENT + WALLET_RENT + 20_000n;
  const have = BigInt(await connection.getBalance(depositor.publicKey, "confirmed"));
  console.log(`depositor ${depositor.publicKey.toBase58()} holds ${have}, needs ${need} for this deposit`);

  // ---------- 1. SSE listener (opened BEFORE the transition) ----------
  const ac = new AbortController();
  const sse = await fetch(`${API}/api/events`, { signal: ac.signal, headers: { Accept: "text/event-stream" } });
  console.log(`SSE connected: HTTP ${sse.status}`);
  const reader = sse.body!.getReader();
  const dec = new TextDecoder();
  const frames: string[] = [];
  const pumping = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of dec.decode(value).split("\n")) if (line.trim()) frames.push(line.trim());
      }
    } catch { /* aborted */ }
  })();

  // ---------- 2. top up the depositor if needed ----------
  if (have < need) {
    const top = need - have;
    const ix = {
      programId: PublicKey.default ? (await import("@solana/web3.js")).SystemProgram.programId : null,
    };
    const { SystemProgram } = await import("@solana/web3.js");
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: op.publicKey, blockhash, lastValidBlockHeight }).add(
      SystemProgram.transfer({ fromPubkey: op.publicKey, toPubkey: depositor.publicKey, lamports: top })
    );
    tx.partialSign(op);
    const sig = await sendAndConfirmTransaction(connection, tx, [op], { commitment: "confirmed" });
    console.log(`\ntop-up ${top} lamports to the depositor: ${sig}`);
  }

  // ---------- 3. the filling deposit ----------
  const escBefore = (await connection.getAccountInfo(new PublicKey(before!.escrow), "confirmed"))!.lamports;
  const ix = depositIx(PROGRAM_ID, depositor.publicKey, roundId, depositLamports);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: depositor.publicKey, blockhash, lastValidBlockHeight }).add(ix);
  tx.partialSign(depositor);
  const sig = await sendAndConfirmTransaction(connection, tx, [depositor], { commitment: "confirmed" });
  const after = await roundState();
  console.log(`\nfilling deposit ${depositLamports} lamports`);
  console.log(`  signature ${sig}`);
  console.log(`  explorer  https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  console.log(`  pot ${before!.pot} -> ${after!.pot}   status ${before!.statusName} -> ${after!.statusName}`);

  // ---------- 4. let the API driver run the rest ----------
  console.log(`\nwaiting for the API settlement driver to lock/settle/pay round ${roundId}...`);
  const seen = new Set<string>();
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const s = await roundState();
    const tag = `${s!.statusName}`;
    if (!seen.has(tag)) {
      seen.add(tag);
      console.log(`  [${new Date().toISOString().slice(11, 19)}] chain state: ${tag}  pot ${s!.pot}`);
    }
    if (s!.statusName === "COMPLETED") {
      console.log(`\n  COMPLETED via the API driver`);
      console.log(`  winner   ${s!.winner}`);
      console.log(`  payout   ${s!.payout}`);
      console.log(`  fee      ${s!.fee}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }

  const fin = await roundState();
  const escAfter = (await connection.getAccountInfo(new PublicKey(fin!.escrow), "confirmed"))!.lamports;
  const tre = await connection.getBalance(TREASURY, "confirmed");
  console.log(`\n  final round state ${fin!.statusName}  escrow ${escBefore} -> ${escAfter}`);
  console.log(`  treasury balance ${tre}`);
  await new Promise((r) => setTimeout(r, 2000));
  ac.abort();
  await pumping;

  console.log(`\n  SSE frames received: ${frames.length}`);
  for (const f of frames) console.log(`    ${f.slice(0, 190)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
