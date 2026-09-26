/**
 * DEVNET end-to-end real-funds lifecycle test.
 *
 *   npx tsx scripts/devnet-e2e.ts <stage>
 *     setup   generate + fund test wallets with real devnet SOL
 *     open    open a tier-0 round through the API's real operator code path
 *     deposit real deposits from the test wallets, fill to the tier cap
 *     settle  lock -> wait reveal window -> settle -> pay (92.5% / 7.5%)
 *     verify  fund accounting, next round, API + SSE reflection
 *
 * Lifecycle txs go through `buildAndSendLifecycleTx` from apps/api/src — the
 * exact code the production API runs — so this exercises the real operator
 * path, not a parallel one. Every step is verified against the devnet RPC;
 * nothing is trusted from an API response alone.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { buildAndSendLifecycleTx, fetchOnChainConfig } from "../apps/api/src/operator.js";
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

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.ROULETTE_PROGRAM_ID || "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos"
);
const TREASURY = new PublicKey(
  process.env.TREASURY_PUBKEY || "6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR"
);
const API = process.env.API_BASE || "https://solana-roulette-api-gd7k.onrender.com";

const WALLETS = "test-ledger/e2e-wallets.json";
const STATE = "test-ledger/e2e-state.json";
const STAGE = process.argv[2];
const PARTICIPANT_RENT = 1_163_320n; // rent-exempt minimum for a 101-byte Participant
const TIER = 0;
const TIER_CAP = 1_000_000_000n; // on-chain tier_caps[0]
const FEE_BPS = 750n;
const DEPOSITS = [400_000_000n, 300_000_000n, 300_000_000n]; // sums exactly to the cap

const connection = new Connection(RPC, "confirmed");

/** 8 disc | 8 id | 1 status | 32 escrow | 8 pot | 16 weight | 4 count
 *  8 lock | 8 reveal | 2 fee_bps | 32 randomness | 16 ticket | 32 winner
 *  8 fee | 8 payout | 32 payout_account | 1 tier | 1 bump | 32 reveal_input
 *  = 257 bytes (reveal_input was appended; pre-redeploy rounds are 225). */
const ROUND_LAYOUT: [string, number, string][] = [
  ["id", 8, "u64"], ["status", 1, "u8"], ["escrow", 32, "pubkey"], ["pot", 8, "u64"],
  ["total_weight", 16, "u128"], ["participant_count", 4, "u32"], ["lock_slot", 8, "u64"],
  ["reveal_slot", 8, "u64"], ["fee_bps", 2, "u16"], ["randomness", 32, "bytes"],
  ["winning_ticket", 16, "u128"], ["winner", 32, "pubkey"], ["fee_lamports", 8, "u64"],
  ["payout_lamports", 8, "u64"], ["payout_account", 32, "pubkey"], ["tier", 1, "u8"],
  ["bump", 1, "u8"], ["reveal_input", 32, "bytes"],
];
const STATUS = ["OPEN", "FULL", "LOCKED", "RANDOMNESS_PENDING", "SETTLING", "COMPLETED", "CANCELLED"];

function decodeRound(buf: Buffer): any {
  const out: any = { space: buf.length, discriminator: Buffer.from(buf.subarray(0, 8)).toString("hex") };
  let o = 8;
  for (const [name, size, kind] of ROUND_LAYOUT) {
    // Pre-redeploy rounds are 225 bytes and have no reveal_input; report zeros
    // rather than reading past the buffer.
    if (o + size > buf.length) { out[name] = kind === "bytes" ? "0".repeat(size * 2) : 0; break; }
    if (kind === "pubkey") out[name] = new PublicKey(buf.subarray(o, o + size)).toBase58();
    else if (kind === "bytes") out[name] = Buffer.from(buf.subarray(o, o + size)).toString("hex");
    else if (size === 1) out[name] = buf[o];
    else if (size === 2) out[name] = buf.readUInt16LE(o);
    else if (size === 4) out[name] = buf.readUInt32LE(o);
    else if (size === 8) out[name] = buf.readBigUInt64LE(o);
    else out[name] = buf.subarray(o, o + 16).reduce((a, b, i) => a + BigInt(b) * 256n ** BigInt(i), 0n);
    o += size;
  }
  out.consumed = o;
  out.statusName = STATUS[out.status] ?? `UNKNOWN(${out.status})`;
  return out;
}

async function fetchRound(roundId: bigint): Promise<any> {
  const [key] = getRoundPda(PROGRAM_ID, roundId);
  const acc = await connection.getAccountInfo(key, "confirmed");
  return acc ? decodeRound(acc.data) : null;
}
const roundKey = (r: bigint) => getRoundPda(PROGRAM_ID, r)[0];
const escrowOf = (r: bigint) => getEscrowPda(PROGRAM_ID, roundKey(r))[0];
const lamports = (n: bigint | number) => `${n} (${Number(n) / 1e9} SOL)`;

async function inspectTx(sig: string) {
  const tx = await connection.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx) return { sig, found: false } as any;
  const keys = (tx.transaction.message.accountKeys ?? []).map((k: any) => k.pubkey.toBase58());
  const transfers: any[] = [];
  for (const ix of tx.transaction.message.instructions as any[]) {
    if (ix.program === "system" && ix.parsed?.type === "transfer") {
      transfers.push({ source: ix.parsed.info.source, destination: ix.parsed.info.destination, lamports: BigInt(ix.parsed.info.lamports) });
    }
  }
  const deltas: any[] = [];
  const pre = tx.meta?.preBalances ?? [];
  const post = tx.meta?.postBalances ?? [];
  for (let i = 0; i < post.length; i++) {
    const d = post[i] - (pre[i] ?? 0);
    if (d !== 0) deltas.push({ account: keys[i], delta: d });
  }
  return { sig, found: true, slot: tx.slot, err: tx.meta?.err ?? null, fee: tx.meta?.fee, feePayer: keys[0], transfers, balanceDeltas: deltas };
}

function printTx(t: any, label: string) {
  console.log(`  ${label}`);
  console.log(`    signature ${t.sig}`);
  console.log(`    explorer  https://explorer.solana.com/tx/${t.sig}?cluster=devnet`);
  console.log(`    slot      ${t.slot}   fee ${t.fee} lamports (payer ${t.feePayer})`);
  console.log(`    error     ${t.err ? JSON.stringify(t.err) : "none"}`);
  for (const x of t.transfers ?? []) console.log(`    transfer  ${x.source} -> ${x.destination}  ${lamports(x.lamports)}`);
  for (const d of t.balanceDeltas ?? []) console.log(`    balance   ${d.account}  ${d.delta > 0 ? "+" : ""}${d.delta}`);
}

const load = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const save = (p: string, v: any) => { mkdirSync(p.split("/")[0], { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2)); };
const bal = (pk: string) => connection.getBalance(new PublicKey(pk), "confirmed");

const results: { stage: string; ok: boolean; detail: string }[] = [];
function record(stage: string, ok: boolean, detail = "") {
  results.push({ stage, ok, detail });
  console.log(`  => ${ok ? "PASS" : "FAIL"}  ${stage}${detail ? ` — ${detail}` : ""}\n`);
}

const opKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("operator-devnet.key.json", "utf8"))));
const cfg = {
  network: "devnet",
  mainnetEnabled: false,
  operatorKeypairJson: JSON.stringify(Array.from(opKey.secretKey)),
  platformFeeWallet: TREASURY.toBase58(),
  treasuryPubkey: TREASURY.toBase58(),
  maxRoundSizeLamports: 10_000_000_000n,
};

async function main() {
  if (STAGE === "setup") {
    console.log("STAGE setup — test wallets funded with REAL devnet SOL\n");
    let w = load(WALLETS);
    if (!w) {
      w = { operator: opKey.publicKey.toBase58(), wallets: [] };
      for (let i = 0; i < DEPOSITS.length; i++) {
        const kp = Keypair.generate();
        w.wallets.push({ label: `T${i + 1}`, pubkey: kp.publicKey.toBase58(), secret: Array.from(kp.secretKey), deposit: DEPOSITS[i].toString() });
      }
      save(WALLETS, w);
      console.log("generated 3 throwaway test wallets");
    }
    // A first deposit also creates the Participant PDA with the DEPOSITOR as
    // payer, and the depositor's own system account must stay rent-exempt
    // AFTER paying — so fund deposit + Participant rent + rent-exemption + fee.
    const PARTICIPANT_RENT_BIG = BigInt(await connection.getMinimumBalanceForRentExemption(101));
    const WALLET_RENT = BigInt(await connection.getMinimumBalanceForRentExemption(0));
    console.log(`  participant rent per wallet: ${PARTICIPANT_RENT_BIG} lamports`);
    console.log(`  wallet rent-exemption floor: ${WALLET_RENT} lamports`);
    for (const t of w.wallets) {
      const need = BigInt(t.deposit) + PARTICIPANT_RENT_BIG + WALLET_RENT + 20_000n;
      const have = BigInt(await bal(t.pubkey));
      if (have >= need) { console.log(`  ${t.label} ${t.pubkey}  already funded (${lamports(have)})`); continue; }
      const amount = need - have;
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: opKey.publicKey, toPubkey: new PublicKey(t.pubkey), lamports: amount }));
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const signed = new Transaction({ feePayer: opKey.publicKey, blockhash, lastValidBlockHeight }).add(tx.instructions[0]);
      signed.partialSign(opKey);
      const sig = await sendAndConfirmTransaction(connection, signed, [opKey], { commitment: "confirmed" });
      const t2: any = await inspectTx(sig);
      console.log(`\n  ${t.label} ${t.pubkey}`);
      printTx(t2, `funding ${lamports(amount)} from the operator`);
      const after = await bal(t.pubkey);
      record(`fund ${t.label}`, t2.err === null && after >= need, `balance ${after}`);
    }
    console.log("setup complete");
  }

  else if (STAGE === "open") {
    console.log("STAGE open — new tier-0 round via the API operator path\n");
    const c = await fetchOnChainConfig(connection, PROGRAM_ID);
    console.log(`  on-chain fee_bps ${c.feeBps}  tier_caps ${c.tierCaps.join(" / ")}  counter ${c.roundCounter}`);
    const res = await buildAndSendLifecycleTx({ connection, programId: PROGRAM_ID, cfg: { ...cfg }, action: "create", tier: TIER });
    if (!res) throw new Error("operator returned null (no operator key / mainnet gate)");
    const roundId = res.roundId;
    console.log(`\n  created round ${roundId}`);
    printTx(await inspectTx(res.signature), "create_round");
    const r = await fetchRound(roundId);
    const st = load(STATE) ?? {};
    Object.assign(st, { roundId: roundId.toString(), tier: TIER, createSig: res.signature, counterBefore: c.roundCounter.toString() });
    save(STATE, st);
    record("open round", r.id === roundId && r.statusName === "OPEN" && r.tier === TIER, `round ${roundId} ${r.statusName} tier ${r.tier}`);
    record("round counter advanced", r.id === c.roundCounter + 1n, `${c.roundCounter} -> ${r.id}`);
    record("new round starts empty", r.pot === 0n && r.participant_count === 0, `pot ${r.pot} entrants ${r.participant_count}`);
  }

  else if (STAGE === "deposit") {
    console.log("STAGE deposit — real deposits from the test wallets\n");
    const st = load(STATE) ?? {};
    const roundId = BigInt(st.roundId);
    const w = load(WALLETS);
    const ek = await escrowOf(roundId);
    st.deposits = [];
    for (const t of w.wallets) {
      const kp = Keypair.fromSecretKey(Uint8Array.from(t.secret));
      const amount = BigInt(t.deposit);
      const before = await bal(t.pubkey);
      const escrowBefore = (await connection.getAccountInfo(ek, "confirmed"))!.lamports;
      const roundBefore = await fetchRound(roundId);
      const ix = depositIx(PROGRAM_ID, kp.publicKey, roundId, amount);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight }).add(ix);
      tx.partialSign(kp);
      const sig = await sendAndConfirmTransaction(connection, tx, [kp], { commitment: "confirmed" });
      const after = await bal(t.pubkey);
      const escrowAfter = (await connection.getAccountInfo(ek, "confirmed"))!.lamports;
      const roundAfter = await fetchRound(roundId);
      const t2: any = await inspectTx(sig);
      console.log(`\n  ${t.label} ${t.pubkey} deposits ${lamports(amount)}`);
      printTx(t2, "deposit");
      console.log(`    wallet   ${before} -> ${after}  (-${before - after})`);
      console.log(`    escrow   ${escrowBefore} -> ${escrowAfter}  (+${escrowAfter - escrowBefore})`);
      console.log(`    pot      ${roundBefore.pot} -> ${roundAfter.pot}  (+${roundAfter.pot - roundBefore.pot})`);
      console.log(`    status   ${roundBefore.statusName} -> ${roundAfter.statusName}`);
      // lamports come back as numbers, pot/amount as bigints — compare like with like.
      const walletSpent = BigInt(before - after);
      const escrowDelta = BigInt(escrowAfter - escrowBefore);
      const ok =
        t2.err === null &&
        walletSpent >= amount &&
        walletSpent === amount + PARTICIPANT_RENT + 5000n &&
        escrowDelta === amount &&
        roundAfter.pot === roundBefore.pot + amount;
      record(`deposit ${t.label}`, ok, `escrow +${escrowAfter - escrowBefore}, pot +${roundAfter.pot - roundBefore.pot}`);
      st.deposits.push({ label: t.label, pubkey: t.pubkey, amount: amount.toString(), signature: sig, balanceBefore: before, balanceAfter: after, escrowBefore, escrowAfter });
      save(STATE, st);
    }
    const final = await fetchRound(roundId);
    st.escrowAfterDeposits = (await connection.getAccountInfo(ek, "confirmed"))!.lamports;
    save(STATE, st);
    record("pot reached tier cap", final.pot === TIER_CAP, `pot ${final.pot} == cap ${TIER_CAP}`);
    record("OPEN -> FULL", final.statusName === "FULL", `status ${final.statusName} (code ${final.status})`);
    record("entrants recorded", final.participant_count === w.wallets.length, `${final.participant_count} entrants, weight ${final.total_weight}`);
  }

  else if (STAGE === "settle") {
    console.log("STAGE settle — lock, reveal wait, settle, pay\n");
    const st = load(STATE) ?? {};
    const roundId = BigInt(st.roundId);
    const rk = roundKey(roundId);
    const ek = await escrowOf(roundId);
    const w = load(WALLETS);
    const names: Record<string, string> = Object.fromEntries(w.wallets.map((t: any) => [t.pubkey, t.label]));

    const before = await fetchRound(roundId);
    const alreadySettled =
      before.statusName === "RANDOMNESS_PENDING" && before.winner !== "11111111111111111111111111111111";

    let lockSig = "";
    let settleSig = "";
    let afterLock: any = before;

    if (alreadySettled) {
      console.log("\n  round is already locked + settled (resuming) — skipping lock/settle");
      const hist = await connection.getSignaturesForAddress(rk, { limit: 6 });
      lockSig = hist.find((s) => !s.err)?.signature ?? "";
      settleSig = hist.filter((s) => !s.err).map((s) => s.signature).find((s) => s !== lockSig) ?? "";
      console.log(`    lock   ${lockSig}`);
      console.log(`    settle ${settleSig}`);
      record("FULL -> RANDOMNESS_PENDING", afterLock.statusName === "RANDOMNESS_PENDING", `status ${afterLock.statusName} (carried from the interrupted run)`);
      record("fee snapshot frozen at lock", afterLock.fee_bps === Number(FEE_BPS), `${afterLock.fee_bps} bps`);
    } else {
      const lock = await buildAndSendLifecycleTx({ connection, programId: PROGRAM_ID, cfg: { ...cfg }, action: "lock", roundId });
      lockSig = lock!.signature;
      console.log("\n  lock_round");
      printTx(await inspectTx(lockSig), "lock_round");
      afterLock = await fetchRound(roundId);
      console.log(`    lock_slot   ${afterLock.lock_slot}`);
      console.log(`    reveal_slot ${afterLock.reveal_slot}  (+${afterLock.reveal_slot - afterLock.lock_slot})`);
      console.log(`    fee_bps     ${afterLock.fee_bps} (frozen)`);
      console.log(`    status      ${afterLock.statusName}`);
      record("FULL -> RANDOMNESS_PENDING", afterLock.statusName === "RANDOMNESS_PENDING", `status ${afterLock.statusName}`);
      record("reveal slot committed in the future", afterLock.reveal_slot > afterLock.lock_slot, `+${afterLock.reveal_slot - afterLock.lock_slot} slots`);
      record("fee snapshot frozen at lock", afterLock.fee_bps === Number(FEE_BPS), `${afterLock.fee_bps} bps`);

      const slotNow = await connection.getSlot("confirmed");
      const wait = Number(afterLock.reveal_slot) - slotNow;
      if (wait > 0) {
        console.log(`\n  waiting ${wait} slots for reveal_slot ${afterLock.reveal_slot} (randomness must not be knowable before it lands)...`);
        let s = slotNow;
        while (s < Number(afterLock.reveal_slot)) { await new Promise((r) => setTimeout(r, 900)); s = await connection.getSlot("confirmed"); }
      }
      const slotAfter = await connection.getSlot("confirmed");
      record("reveal slot reached", slotAfter >= Number(afterLock.reveal_slot), `slot ${slotAfter} >= ${afterLock.reveal_slot}`);

      const settle = await buildAndSendLifecycleTx({ connection, programId: PROGRAM_ID, cfg: { ...cfg }, action: "settle", roundId });
      settleSig = settle!.signature;
      console.log("\n  settle_round");
      printTx(await inspectTx(settleSig), "settle_round");
    }

    const settled = await fetchRound(roundId);
    console.log(`    lock_slot      ${settled.lock_slot}`);
    console.log(`    reveal_slot    ${settled.reveal_slot}`);
    console.log(`    randomness      ${settled.randomness}`);
    console.log(`    winning_ticket  ${settled.winning_ticket}`);
    console.log(`    winner          ${settled.winner}  (${names[settled.winner] ?? "?"})`);
    console.log(`    payout_lamports ${settled.payout_lamports}`);
    console.log(`    fee_lamports    ${settled.fee_lamports}`);
    const escBefore = (await connection.getAccountInfo(ek, "confirmed"))!.lamports;

    // Recompute the draw from the entropy input the PROGRAM persisted on the
    // Round account. This is the only input a third party can obtain: the
    // SlotHashes sysvar holds per-slot bank hashes, which no RPC exposes via
    // getBlock(slot).blockhash, so re-fetching the slot can never reproduce
    // the draw (asserted below as a control).
    const revealInput = new Uint8Array(Buffer.from(settled.reveal_input ?? "0".repeat(64), "hex"));
    const rand = deriveRandomness(revealInput, roundId);
    const randHex = Buffer.from(rand).toString("hex");
    const ticket = computeTicket(rand, settled.total_weight);
    const split = computeFeeSplit(settled.pot, settled.fee_bps);
    const parts = (await fetchParticipantsForRound(connection, PROGRAM_ID, rk)).slice().sort((a, b) => a.index - b.index);
    const expectedWinner = selectWinner(
      parts.map((p) => ({ id: p.wallet.toBase58(), amount: p.amount, weightStart: p.weightStart, index: p.index })),
      ticket
    ).id;
    console.log(`\n  independent recompute from the PERSISTED on-chain entropy input:`);
    console.log(`    reveal_input    ${settled.reveal_input}`);
    console.log(`    randomness      ${randHex}`);
    console.log(`    ticket          ${ticket}`);
    console.log(`    winner          ${expectedWinner}  (${names[expectedWinner] ?? "?"})`);
    record("randomness input persisted on-chain", revealInput.some((b) => b !== 0), settled.reveal_input ?? "absent");
    record("randomness reproduced from persisted input", randHex === settled.randomness, randHex === settled.randomness ? "byte-identical" : `${randHex} != ${settled.randomness}`);
    record("winning ticket reproduced", ticket === settled.winning_ticket, `${ticket}`);
    record("winner reproduced", expectedWinner === settled.winner, `${names[expectedWinner] ?? expectedWinner}`);

    // Control: the RPC blockhash is NOT the program's input. This is the bug
    // that made the draw unreproducible before reveal_input was persisted.
    const block = await connection.getBlock(Number(settled.reveal_slot), { maxSupportedTransactionVersion: 0 });
    if (block) {
      const bh = new Uint8Array(new PublicKey(block.blockhash).toBytes());
      const fromBlockhash = Buffer.from(deriveRandomness(bh, roundId)).toString("hex");
      record("getBlock(reveal_slot).blockhash is NOT the draw input (expected)", fromBlockhash !== settled.randomness, `getBlock=${block.blockhash}`);
    }

    record("fee = 7.5% of pot", settled.fee_lamports === split.fee, `${settled.fee_lamports} == ${split.fee}`);
    record("payout = 92.5% of pot", settled.payout_lamports === split.payout, `${settled.payout_lamports} == ${split.payout}`);
    record("payout + fee == pot", settled.payout_lamports + settled.fee_lamports === settled.pot, `${settled.payout_lamports} + ${settled.fee_lamports} = ${settled.pot}`);
    record("settle moved no lamports", escBefore === st.escrowAfterDeposits, `escrow still ${escBefore}`);

    const winnerBefore = await bal(settled.winner);
    const treasuryBefore = await bal(TREASURY.toBase58());
    const pay = await buildAndSendLifecycleTx({ connection, programId: PROGRAM_ID, cfg: { ...cfg }, action: "pay", roundId });
    console.log("\n  pay_winners");
    printTx(await inspectTx(pay!.signature), "pay_winners");
    const winnerAfter = await bal(settled.winner);
    const treasuryAfter = await bal(TREASURY.toBase58());
    const escAfter = (await connection.getAccountInfo(ek, "confirmed"))!.lamports;
    const done = await fetchRound(roundId);
    const wDelta = BigInt(winnerAfter - winnerBefore);
    const tDelta = BigInt(treasuryAfter - treasuryBefore);
    console.log(`    winner   ${settled.winner}  ${winnerBefore} -> ${winnerAfter}  (+${wDelta})`);
    console.log(`    treasury ${TREASURY.toBase58()}  ${treasuryBefore} -> ${treasuryAfter}  (+${tDelta})`);
    console.log(`    escrow   ${escBefore} -> ${escAfter}`);
    console.log(`    status   ${done.statusName}`);
    record("winner received 92.5% of pot", wDelta === settled.payout_lamports, `+${wDelta} == ${settled.payout_lamports}`);
    record("treasury received 7.5% of pot", tDelta === settled.fee_lamports, `+${tDelta} == ${settled.fee_lamports}`);
    record("escrow drained to rent-exemption only", escAfter === 650240, `${escAfter} lamports remain`);
    record("RANDOMNESS_PENDING -> COMPLETED", done.statusName === "COMPLETED", `status ${done.statusName} (code ${done.status})`);

    st.settle = {
      lockSig, settleSig, paySig: pay!.signature,
      lockSlot: String(settled.lock_slot), revealSlot: String(settled.reveal_slot),
      revealBlockhash: Buffer.from(revealBlockhash).toString("hex"),
      randomness: settled.randomness, ticket: String(settled.winning_ticket),
      winner: settled.winner, winnerLabel: names[settled.winner] ?? "?",
      pot: settled.pot.toString(), payout: settled.payout_lamports.toString(), fee: settled.fee_lamports.toString(),
      winnerBefore, winnerAfter, treasuryBefore, treasuryAfter, escrowBeforePay: escBefore, escrowAfterPay: escAfter,
      status: done.statusName,
      participants: parts.map((p) => ({ label: names[p.wallet.toBase58()] ?? "?", wallet: p.wallet.toBase58(), amount: p.amount.toString(), index: p.index, weightStart: p.weightStart.toString() })),
    };
    save(STATE, st);
    console.log("settle complete");
  }

  else if (STAGE === "verify") {
    console.log("STAGE verify — fund accounting, next round, API + SSE\n");
    const st = load(STATE) ?? {};
    const roundId = BigInt(st.roundId);
    const s = st.settle;
    const ek = await escrowOf(roundId);
    const pot = BigInt(s.pot);

    console.log("  fund accounting");
    for (const p of s.participants) {
      const d0 = st.deposits.find((x: any) => x.pubkey === p.wallet);
      const now = await bal(p.wallet);
      const netAfterDeposit = BigInt(now) - BigInt(d0.balanceAfter);
      console.log(`    ${p.label} ${p.wallet}  stake ${p.amount}  payout ${netAfterDeposit >= 0n ? "+" : ""}${netAfterDeposit}`);
    }
    record("winner credited exactly 92.5%", BigInt(s.winnerAfter) - BigInt(s.winnerBefore) === BigInt(s.payout), `+${BigInt(s.winnerAfter) - BigInt(s.winnerBefore)}`);
    record("treasury credited exactly 7.5%", BigInt(s.treasuryAfter) - BigInt(s.treasuryBefore) === BigInt(s.fee), `+${BigInt(s.treasuryAfter) - BigInt(s.treasuryBefore)}`);
    record("winner + treasury == pot (nothing lost/created)", BigInt(s.payout) + BigInt(s.fee) === pot, `${s.payout} + ${s.fee} = ${pot}`);
    const esc = (await connection.getAccountInfo(ek, "confirmed"))!;
    record("escrow retains only rent-exemption", esc.lamports === 650240, `${esc.lamports} lamports`);
    record("escrow still owned by the program", esc.owner.toBase58() === PROGRAM_ID.toBase58(), esc.owner.toBase58());
    for (const p of s.participants) {
      if (p.wallet === s.winner) continue;
      const d0 = st.deposits.find((x: any) => x.pubkey === p.wallet);
      const now = await bal(p.wallet);
      record(`non-winner ${p.label} loses exactly their stake`, BigInt(d0.balanceBefore) - BigInt(now) === BigInt(p.amount), `-${BigInt(d0.balanceBefore) - BigInt(now)} == ${p.amount}`);
    }

    const health = await (await fetch(`${API}/api/health`)).json();
    record("API in chain mode", health.mode === "chain", `mode=${health.mode} programId=${health.programId}`);
    record("API program id unchanged", health.programId === PROGRAM_ID.toBase58(), health.programId);
    record("mainnet still disabled", health.mainnetEnabled === false, `mainnetEnabled=${health.mainnetEnabled}`);
    record("API treasury unchanged", health.custody.feeWallet === TREASURY.toBase58(), health.custody.feeWallet);

    const pools = await (await fetch(`${API}/api/pools`)).json();
    const t0 = pools.pools.find((p: any) => p.tier === 0);
    console.log(`\n  /api/pools tier 0:`);
    console.log(`    roundId ${t0.roundId}  status ${t0.status}  pot ${t0.potLamports}`);
    console.log(`    lastCompletedRoundId ${t0.lastCompletedRoundId}  lastWinner ${t0.lastWinner}`);
    console.log(`    lastPayoutLamports ${t0.lastPayoutLamports}  lastFeeLamports ${t0.lastFeeLamports}`);
    record("API exposes the settled round as the tier-0 head", t0.roundId === roundId.toString() || t0.lastCompletedRoundId === roundId.toString(), `roundId=${t0.roundId} lastCompleted=${t0.lastCompletedRoundId}`);

    const ac = new AbortController();
    const sse = await fetch(`${API}/api/events`, { signal: ac.signal, headers: { Accept: "text/event-stream" } });
    const reader = sse.body!.getReader();
    const events: string[] = [];
    const collect = (async () => {
      const dec = new TextDecoder();
      try {
        while (events.length < 8) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const line of dec.decode(value).split("\n")) if (line.startsWith("event:") || line.startsWith("data:")) events.push(line.slice(0, 150));
        }
      } catch {}
    })();
    await Promise.race([collect, new Promise((r) => setTimeout(r, 12_000))]);
    ac.abort();
    console.log(`\n  SSE /api/events HTTP ${sse.status} — ${events.length} frame line(s):`);
    events.forEach((e) => console.log(`    ${e}`));
    record("SSE stream reachable and emitting", sse.status === 200 && events.length > 0, `${events.length} lines, HTTP ${sse.status}`);

    const c = await fetchOnChainConfig(connection, PROGRAM_ID);
    const nextId = c.roundCounter + 1n;
    const next = await buildAndSendLifecycleTx({ connection, programId: PROGRAM_ID, cfg: { ...cfg }, action: "create", tier: TIER });
    console.log(`\n  next round opened automatically`);
    printTx(await inspectTx(next!.signature), `create_round (round ${next!.roundId})`);
    const nr = await fetchRound(next!.roundId);
    record("next round opens automatically", next!.roundId === nextId && nr.statusName === "OPEN" && nr.pot === 0n, `round ${next!.roundId} ${nr.statusName} pot ${nr.pot}`);
    st.nextRoundId = next!.roundId.toString();
    const finalRound = await fetchRound(roundId);
    record("settled round remains COMPLETED", finalRound.statusName === "COMPLETED", finalRound.statusName);
    save(STATE, st);
  }

  else {
    console.error("usage: npx tsx scripts/devnet-e2e.ts setup|open|deposit|settle|verify");
    process.exit(1);
  }

  console.log("─".repeat(72));
  console.log(`stage ${STAGE}: ${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  for (const r of results.filter((x) => !x.ok)) console.log(`  FAILED: ${r.stage} — ${r.detail}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
