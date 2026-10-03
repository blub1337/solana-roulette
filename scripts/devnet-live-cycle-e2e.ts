/**
 * LIVE production roulette cycle on the Render-deployed platform.
 *
 * Two throwaway devnet wallets join the LIVE platform's current tier-0 round
 * through the SAME public API and the SAME on-chain program the browser uses:
 *
 *   1. POST /api/round/:id/deposit/intent   → the live backend opens a deposit
 *      record against the round's program escrow (chain mode)
 *   2. the wallet signs and sends the program `deposit` instruction (this is
 *      exactly what the connected browser wallet builds via packages/sdk)
 *   3. POST /api/round/:id/deposit/confirm  → the live backend re-reads the tx
 *      from devnet and credits it only when it is a real, error-free deposit
 *
 * Filling the pool to its tier cap flips it OPEN → FULL, and the DEPLOYED
 * settlement driver (not this script) locks, settles and pays. This script then
 * reads the result independently: winner vs loser balances, the 98%/2% split,
 * the escrow drain, and the API's own /verify endpoint.
 *
 *   npx tsx scripts/devnet-live-cycle-e2e.ts deposit   # join the live round
 *   npx tsx scripts/devnet-live-cycle-e2e.ts watch     # observe + verify + report
 *
 * Real devnet SOL moves. Browser wallet clicks cannot be automated headlessly,
 * so the wallet interaction here is the identical sign-and-send path the wallet
 * adapter performs; everything else (API, program, settlement, payout) is the
 * live production stack.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  deriveRandomness,
  computeTicket,
  computeFeeSplit,
  selectWinner,
  fetchParticipantsForRound,
  getRoundPda,
  getEscrowPda,
} from "../packages/verification/src/index.js";
import { depositIx } from "../packages/sdk/src/instructions.js";

const RPC = "https://api.devnet.solana.com";
const API = "https://solana-roulette-api-gd7k.onrender.com";
const PROGRAM_ID = new PublicKey("F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos");
const WALLETS_FILE = "test-ledger/e2e-wallets.json";
const STATE_FILE = "test-ledger/live-cycle-state.json";

const PHASE = process.argv[2];
const connection = new Connection(RPC, "confirmed");

/** (label, lamports) — sums to the 1 SOL tier-0 cap. */
const PLAN: Array<{ label: string; lamports: bigint }> = [
  { label: "T1", lamports: 600_000_000n },
  { label: "T3", lamports: 400_000_000n },
];
const TIER = 0;
const TIER_CAP = 1_000_000_000n;
const FEE_BPS = 200n;
const ESCROW_RENT_FLOOR = 650_240n;

const STATUS = ["OPEN", "FULL", "LOCKED", "RANDOMNESS_PENDING", "SETTLING", "COMPLETED", "CANCELLED"];
const ROUND_LAYOUT: [string, number, string][] = [
  ["id", 8, "u64"], ["status", 1, "u8"], ["escrow", 32, "pubkey"], ["pot", 8, "u64"],
  ["total_weight", 16, "u128"], ["participant_count", 4, "u32"], ["lock_slot", 8, "u64"],
  ["reveal_slot", 8, "u64"], ["fee_bps", 2, "u16"], ["randomness", 32, "bytes"],
  ["winning_ticket", 16, "u128"], ["winner", 32, "pubkey"], ["fee_lamports", 8, "u64"],
  ["payout_lamports", 8, "u64"], ["payout_account", 32, "pubkey"], ["tier", 1, "u8"],
  ["bump", 1, "u8"], ["reveal_input", 32, "bytes"],
];

function decodeRound(buf: Buffer): any {
  const out: any = { space: buf.length };
  let o = 8;
  for (const [name, size, kind] of ROUND_LAYOUT) {
    if (o + size > buf.length) { out[name] = kind === "bytes" ? "0".repeat(size * 2) : 0; break; }
    if (kind === "pubkey") out[name] = new PublicKey(buf.subarray(o, o + size)).toBase58();
    else if (kind === "bytes") out[name] = Buffer.from(buf.subarray(o, o + size)).toString("hex");
    else if (size === 1) out[name] = buf[o];
    else if (size === 2) out[name] = buf.readUInt16LE(o);
    else if (size === 4) out[name] = buf.readUInt32LE(o);
    else if (size === 8) out[name] = buf.readBigUInt64LE(o);
    else out[name] = buf.subarray(o, o + 16).reduce((a: bigint, b: number, i: number) => a + BigInt(b) * 256n ** BigInt(i), 0n);
    o += size;
  }
  out.statusName = STATUS[out.status] ?? `UNKNOWN(${out.status})`;
  return out;
}

const roundKey = (r: bigint) => getRoundPda(PROGRAM_ID, r)[0];
const escrowOf = (r: bigint) => getEscrowPda(PROGRAM_ID, roundKey(r))[0];
const bal = (pk: PublicKey) => connection.getBalance(pk, "confirmed");

async function chainRound(roundId: bigint): Promise<any> {
  const acc = await connection.getAccountInfo(roundKey(roundId), "confirmed");
  return acc ? decodeRound(acc.data) : null;
}

async function apiJson(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${API}${path}`, init);
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, ok: res.ok, json };
}

const load = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const save = (p: string, v: any) => writeFileSync(p, JSON.stringify(v, null, 2));
const sol = (l: bigint | number) => `${(Number(l) / 1e9).toFixed(4)} SOL`;
const results: { ok: boolean; check: string; detail: string }[] = [];
function check(ok: boolean, name: string, detail = "") {
  results.push({ ok, check: name, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function keypairFor(label: string): Keypair {
  const w = JSON.parse(readFileSync(WALLETS_FILE, "utf8"));
  const t = w.wallets.find((x: any) => x.label === label);
  if (!t) throw new Error(`wallet ${label} not found`);
  return Keypair.fromSecretKey(Uint8Array.from(t.secret));
}

async function phaseDeposit() {
  console.log("=".repeat(78));
  console.log("PHASE deposit — join the LIVE tier-0 round via the public API");
  console.log("=".repeat(78));

  const health = await apiJson("/api/health");
  console.log(`health: mode=${health.json.mode} realFunds=${health.json.realFunds} network=${health.json.network}`);
  check(health.json.mode === "chain", "live backend is in chain mode", `mode=${health.json.mode}`);

  const pools = await apiJson("/api/pools");
  const t0 = pools.json.pools.find((p: any) => p.tier === TIER);
  console.log(`live tier-0 head: round ${t0.roundId} ${t0.status} pot ${t0.potLamports}`);
  check(t0.status === "OPEN" && BigInt(t0.potLamports) === 0n, "live round is OPEN and empty", `pot ${t0.potLamports}`);
  const roundId = BigInt(t0.roundId);

  const state: any = { roundId: roundId.toString(), tier: TIER, api: API, programId: PROGRAM_ID.toBase58(), startedAt: new Date().toISOString(), deposits: [] };
  const before = await chainRound(roundId);
  state.escrowBefore = (await connection.getAccountInfo(escrowOf(roundId), "confirmed"))!.lamports;

  for (const p of PLAN) {
    const kp = keypairFor(p.label);
    console.log(`\n${p.label} ${kp.publicKey.toBase58()} deposits ${sol(p.lamports)}`);
    const balBefore = await bal(kp.publicKey);

    // 1) intent on the live backend
    const intent = await apiJson(`/api/round/${roundId}/deposit/intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: kp.publicKey.toBase58(), amountLamports: p.lamports.toString() }),
    });
    console.log(`  intent HTTP ${intent.status}  depositId=${intent.json.depositId} escrow=${intent.json.escrow}`);
    if (!intent.ok) throw new Error(`intent failed: ${JSON.stringify(intent.json).slice(0, 300)}`);
    check(new PublicKey(intent.json.escrow).equals(escrowOf(roundId)), `${p.label} intent escrow == program escrow PDA`);

    // 2) the real on-chain program deposit, signed by the player
    const ix = depositIx(PROGRAM_ID, kp.publicKey, roundId, p.lamports);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight }).add(ix);
    tx.partialSign(kp);
    const signature = await sendAndConfirmTransaction(connection, tx, [kp], { commitment: "confirmed" });
    console.log(`  deposit tx ${signature}`);
    console.log(`  explorer   https://explorer.solana.com/tx/${signature}?cluster=devnet`);

    // 3) confirm on the live backend (it re-reads devnet)
    const confirm = await apiJson(`/api/round/${roundId}/deposit/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ depositId: intent.json.depositId, signature, roundId: roundId.toString() }),
    });
    console.log(`  confirm HTTP ${confirm.status}  credited=${confirm.json.credited} pot=${confirm.json.potLamports}`);
    check(confirm.ok && confirm.json.credited === true, `${p.label} deposit confirmed + credited by the live backend`, `HTTP ${confirm.status}`);

    const balAfter = await bal(kp.publicKey);
    const r = await chainRound(roundId);
    const escNow = (await connection.getAccountInfo(escrowOf(roundId), "confirmed"))!.lamports;
    console.log(`  wallet ${sol(balBefore)} -> ${sol(balAfter)}   pot ${r.pot} status ${r.statusName}  escrow ${escNow}`);
    check(r.pot > 0n, `${p.label} stake is on-chain in the round`, `pot ${r.pot}`);
    state.deposits.push({
      label: p.label, pubkey: kp.publicKey.toBase58(), lamports: p.lamports.toString(),
      depositId: intent.json.depositId, signature, balBefore, balAfter,
    });
    save(STATE_FILE, state);
  }

  const final = await chainRound(roundId);
  state.escrowAfterDeposits = (await connection.getAccountInfo(escrowOf(roundId), "confirmed"))!.lamports;
  state.pot = final.pot.toString();
  state.statusAfterDeposits = final.statusName;
  save(STATE_FILE, state);
  console.log(`\nfinal: pot ${final.pot} ${final.statusName} (cap ${TIER_CAP})  claimants ${final.participant_count}`);
  check(final.pot === TIER_CAP, "pot reached the tier cap", `${final.pot} == ${TIER_CAP}`);
  check(final.statusName === "FULL", "OPEN -> FULL", `status ${final.statusName}`);
  check(final.participant_count === PLAN.length, "both participants recorded", `${final.participant_count}`);
  report();
}

async function phaseWatch() {
  console.log("=".repeat(78));
  console.log("PHASE watch — let the DEPLOYED settlement driver finish the round");
  console.log("=".repeat(78));
  const state: any = load(STATE_FILE);
  if (!state) throw new Error(`no state at ${STATE_FILE}; run the deposit phase first`);
  const roundId = BigInt(state.roundId);
  const names: Record<string, string> = Object.fromEntries(state.deposits.map((d: any) => [d.pubkey, d.label]));
  state.watch = { seen: [] };

  // SSE: watch the live event stream while the driver works.
  const ac = new AbortController();
  const sseFrames: string[] = [];
  const sse = await fetch(`${API}/api/events`, { signal: ac.signal, headers: { Accept: "text/event-stream" } }).catch(() => null);
  if (sse?.body) {
    const reader = sse.body.getReader();
    const dec = new TextDecoder();
    void (async () => {
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; for (const l of dec.decode(value).split("\n")) if (l.trim()) sseFrames.push(l.trim()); } } catch { /* aborted */ }
    })();
  }
  console.log(`SSE /api/events HTTP ${sse?.status ?? "n/a"}`);

  const seen = new Set<string>();
  const deadline = Date.now() + 150_000;
  let done = await chainRound(roundId);
  while (Date.now() < deadline && done!.statusName !== "COMPLETED") {
    if (!seen.has(done!.statusName)) {
      seen.add(done!.statusName);
      state.watch.seen.push({ at: new Date().toISOString(), status: done!.statusName, pot: done!.pot.toString() });
      console.log(`  [${new Date().toISOString().slice(11, 19)}] chain: ${done!.statusName}  pot ${done!.pot}`);
    }
    await new Promise((r) => setTimeout(r, 4_000));
    done = await chainRound(roundId);
  }
  ac.abort();

  const fin = await chainRound(roundId);
  console.log(`\nfinal chain state: ${fin!.statusName}`);
  check(fin!.statusName === "COMPLETED", "deployed driver drove the round to COMPLETED", `status ${fin!.statusName}`);

  // --- independent recomputation from the persisted on-chain entropy input ---
  const revealInput = new Uint8Array(Buffer.from(fin!.reveal_input, "hex"));
  const rand = deriveRandomness(revealInput, roundId);
  const randHex = Buffer.from(rand).toString("hex");
  const ticket = computeTicket(rand, fin!.total_weight);
  const parts = (await fetchParticipantsForRound(connection, PROGRAM_ID, roundKey(roundId))).slice().sort((a, b) => a.index - b.index);
  const expectedWinner = selectWinner(
    parts.map((p) => ({ id: p.wallet.toBase58(), amount: p.amount, weightStart: p.weightStart, index: p.index })),
    ticket
  ).id;
  check(randHex === fin!.randomness, "randomness reproduced from on-chain reveal_input", randHex.slice(0, 24) + "…");
  check(expectedWinner === fin!.winner, "winner reproduced independently", `${names[expectedWinner] ?? expectedWinner}`);

  const split = computeFeeSplit(fin!.pot, fin!.fee_bps);
  check(fin!.payout_lamports === split.payout, "payout == pot - fee", `${fin!.payout_lamports}`);
  check(fin!.fee_lamports === split.fee, "fee == fee_bps share of pot", `${fin!.fee_lamports} @ ${fin!.fee_bps} bps`);
  check(fin!.payout_lamports + fin!.fee_lamports === fin!.pot, "payout + fee == pot (nothing lost)", `${fin!.payout_lamports} + ${fin!.fee_lamports} == ${fin!.pot}`);

  // --- wallet states: winner paid, loser keeps only the loss ---
  const health = await apiJson("/api/health");
  const treasury = `${health.json.custody.feeWallet}`;
  for (const d of state.deposits) {
    const now = BigInt(await bal(new PublicKey(d.pubkey)));
    const delta = now - BigInt(d.balAfter);
    state.deposits.find((x: any) => x.label === d.label).balanceFinal = now.toString();
    if (d.pubkey === fin!.winner) {
      console.log(`  WINNER ${d.label} ${d.pubkey}  +${delta} lamports (payout)`);
      check(delta === fin!.payout_lamports, "winner credited the payout", `${names[d.pubkey]} +${delta}`);
    } else {
      console.log(`  LOSER  ${d.label} ${d.pubkey}  ${delta} lamports (unchanged after deposit)`);
      check(delta === 0n, "loser received nothing", `${names[d.pubkey]} delta ${delta}`);
    }
  }

  // treasury delta over the observed window (read before/after around the pay).
  const tre = BigInt(await bal(new PublicKey(treasury)));
  state.treasury = { pubkey: treasury, balance: tre.toString() };
  console.log(`  TREASURY ${treasury}  balance ${tre}`);

  const esc = (await connection.getAccountInfo(escrowOf(roundId), "confirmed"))!;
  // Account lamports are a JS number; compare in bigint to avoid number === bigint.
  check(BigInt(esc.lamports) === ESCROW_RENT_FLOOR, "round escrow drained to the rent floor", `${esc.lamports} lamports`);
  check(esc.owner.toBase58() === PROGRAM_ID.toBase58(), "escrow still owned by the program", esc.owner.toBase58());

  // Locate the pay_winners transaction on chain and prove the treasury received
  // exactly the fee share (independent of any API response).
  const sigs = await connection.getSignaturesForAddress(roundKey(roundId), { limit: 10 });
  state.watch.signatures = sigs.map((s) => ({ signature: s.signature, err: s.err, slot: s.slot }));
  let paySig: string | null = null;
  let treasuryDelta: bigint | null = null;
  const treasuryPk = new PublicKey(treasury);
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await connection.getParsedTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx || !tx.meta) continue;
    const keys = (tx.transaction.message as any).accountKeys?.map((k: any) => k.pubkey?.toBase58() ?? String(k)) ?? [];
    const idx = keys.indexOf(treasury);
    if (idx < 0) continue;
    const delta = BigInt(tx.meta.postBalances[idx] - tx.meta.preBalances[idx]);
    if (delta > 0n) { paySig = s.signature; treasuryDelta = delta; break; }
    void treasuryPk;
  }
  state.watch.payout = { paySignature: paySig, treasuryDelta: treasuryDelta?.toString() ?? null };
  if (paySig) console.log(`  pay_winners tx ${paySig}`);
  check(treasuryDelta === fin!.fee_lamports, "treasury received exactly the fee share (from the pay tx)", `${treasuryDelta} == ${fin!.fee_lamports}`);

  // --- the live API's own view + independent verify endpoint ---
  const apiRound = await apiJson(`/api/round/${roundId}`);
  const verify = await apiJson(`/api/round/${roundId}/verify`);
  check(verify.json.ok === true, "live API /verify confirms the winner", `ok=${verify.json.ok}`);
  check(verify.json.trace?.computedWinner === fin!.winner, "API recomputed winner == on-chain winner", `${verify.json.trace?.computedWinner}`);

  const history = await apiJson("/api/history");
  const histEntry = (history.json.rounds ?? []).find((r: any) => String(r.roundId ?? r.id) === roundId.toString());
  if (histEntry) console.log(`  /api/history round ${roundId}: winner ${histEntry.winner} payout ${histEntry.payoutLamports} fee ${histEntry.feeLamports}`);
  state.watch.historyEntry = histEntry ?? null;

  const pools = await apiJson("/api/pools");
  const t0 = pools.json.pools.find((p: any) => p.tier === TIER);
  check(t0.lastCompletedRoundId === roundId.toString() || t0.roundId !== roundId.toString(), "tier-0 lane advanced to a fresh round", `head ${t0.roundId} lastCompleted ${t0.lastCompletedRoundId}`);
  check(t0.lastWinner === fin!.winner, "pool card shows the settled winner", `${t0.lastWinner}`);
  check(t0.lastPayoutLamports === fin!.payout_lamports.toString(), "pool card shows the payout", `${t0.lastPayoutLamports}`);

  state.watch.finalChain = {
    status: fin!.statusName, winner: fin!.winner, winnerLabel: names[fin!.winner] ?? "?",
    pot: fin!.pot.toString(), payout: fin!.payout_lamports.toString(), fee: fin!.fee_lamports.toString(),
    randomness: fin!.randomness, winningTicket: fin!.winning_ticket.toString(), revealInput: fin!.reveal_input,
    escrowLamports: esc.lamports, treasuryBalance: tre.toString(),
    apiVerifyOk: verify.json.ok, apiPoolsTier0: { roundId: t0.roundId, lastCompletedRoundId: t0.lastCompletedRoundId, lastWinner: t0.lastWinner, lastPayout: t0.lastPayoutLamports },
    participants: parts.map((p) => ({ label: names[p.wallet.toBase58()] ?? "?", wallet: p.wallet.toBase58(), amount: p.amount.toString(), index: p.index })),
  };
  state.watch.sseFrames = sseFrames.slice(0, 40);
  state.finishedAt = new Date().toISOString();
  save(STATE_FILE, state);
  report();
}

function report() {
  const passed = results.filter((r) => r.ok).length;
  console.log("\n" + "─".repeat(78));
  console.log(`RESULT: ${passed}/${results.length} checks passed`);
  for (const r of results.filter((x) => !x.ok)) console.log(`  FAILED: ${r.check} — ${r.detail}`);
  console.log(`state written to ${STATE_FILE}`);
}

async function main() {
  if (PHASE === "deposit") return phaseDeposit();
  if (PHASE === "watch") return phaseWatch();
  console.error("usage: npx tsx scripts/devnet-live-cycle-e2e.ts deposit|watch");
  process.exit(1);
}

main().catch((e) => { console.error("CRASH:", e instanceof Error ? e.message : e); process.exit(1); });
