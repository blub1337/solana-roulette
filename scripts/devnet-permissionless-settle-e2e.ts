/**
 * B2 E2E — prove settlement is genuinely PERMISSIONLESS on Solana devnet.
 *
 *   npx tsx scripts/devnet-permissionless-settle-e2e.ts
 *
 * Everything here is a real devnet transaction verified through the RPC. The
 * operator is NOT used for lock, settle or pay: a freshly generated stranger
 * wallet (never the configured operator) signs all three. If any of them still
 * required the operator key, the whole run would fail.
 *
 * The stranger only needs SOL for transaction fees. Every amount, recipient
 * and fee comes from on-chain state the program froze itself.
 *
 * The run also attempts the attack the `slot_hashes` address pin exists to
 * stop: settle with a caller-owned account full of attacker-chosen
 * `(reveal_slot, hash)` bytes in place of the real SlotHashes sysvar. Before
 * the pin that would have let anyone pick the winner; it must now revert.
 */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  configPda,
  escrowPda,
  roundPda,
  createRoundInstruction,
  depositIx,
  lockRoundIx,
  settleRoundIx,
  payWinnersIx,
  participantPda,
} from "../packages/sdk/src/index.js";
import { deriveRandomness, computeTicket, selectWinner } from "../packages/verification/src/index.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM = new PublicKey(
  process.env.ROULETTE_PROGRAM_ID || "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos"
);
const TIER = 0;
const TIER_CAP = 1_000_000_000n; // 1 SOL
const TREASURY = new PublicKey("6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR");
const STRANGER_FILE = "test-ledger/e2e-stranger.json";
const WALLETS_FILE = "test-ledger/e2e-wallets.json";
const STATE_FILE = "test-ledger/e2e-state.json";

const connection = new Connection(RPC, "confirmed");
const explorer = (s: string) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): boolean {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
  return ok;
}

async function send(ix: TransactionInstruction, signers: Keypair[], label: string) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: signers[0]!.publicKey, blockhash, lastValidBlockHeight }).add(ix);
  tx.partialSign(...signers);
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
}

// --- Round account layout, mirroring programs/roulette/src/state.rs ----------
// Derived from the field order, not from memory. `total_weight` is 16 bytes,
// so lock_slot is at 77 (NOT 81) and reveal_slot at 85 (NOT 89); the
// `reveal_slot == lock_slot + 32` assertion below is what caught that.
const O_STATUS = 16;
const O_ESCROW = 17;
const O_POT = 49;
const O_COUNT = 73;
const O_LOCK_SLOT = 77;
const O_REVEAL_SLOT = 85;
const O_FEE_BPS = 93;
const O_RANDOMNESS = 95;
const O_TICKET = 127;
const O_WINNER = 143;
const O_FEE = 175;
const O_PAYOUT = 183;
const O_REVEAL_INPUT = 225;
const ROUND_SPACE = 257;
const STATUS = ["OPEN", "FULL", "LOCKED", "RANDOMNESS_PENDING", "SETTLING", "COMPLETED", "CANCELLED"] as const;

interface RoundView {
  id: bigint;
  status: number;
  escrow: PublicKey;
  pot: bigint;
  count: number;
  lockSlot: bigint;
  revealSlot: bigint;
  feeBps: number;
  randomness: Uint8Array;
  ticket: bigint;
  winner: PublicKey;
  fee: bigint;
  payout: bigint;
  revealInput: Uint8Array;
}

function decode(buf: Buffer): RoundView {
  return {
    id: buf.readBigUInt64LE(8),
    status: buf[O_STATUS]!,
    escrow: new PublicKey(buf.subarray(O_ESCROW, O_ESCROW + 32)),
    pot: buf.readBigUInt64LE(O_POT),
    count: buf.readUInt32LE(O_COUNT),
    lockSlot: buf.readBigUInt64LE(O_LOCK_SLOT),
    revealSlot: buf.readBigUInt64LE(O_REVEAL_SLOT),
    feeBps: buf.readUInt16LE(O_FEE_BPS),
    randomness: buf.subarray(O_RANDOMNESS, O_RANDOMNESS + 32),
    ticket: buf.readBigUInt64LE(O_TICKET),
    winner: new PublicKey(buf.subarray(O_WINNER, O_WINNER + 32)),
    fee: buf.readBigUInt64LE(O_FEE),
    payout: buf.readBigUInt64LE(O_PAYOUT),
    revealInput: buf.subarray(O_REVEAL_INPUT, O_REVEAL_INPUT + 32),
  };
}

async function readRound(roundId: bigint): Promise<RoundView | null> {
  const acc = await connection.getAccountInfo(roundPda(PROGRAM, roundId), "confirmed");
  if (!acc) return null;
  if (acc.data.length !== ROUND_SPACE) {
    throw new Error(`round ${roundId} is ${acc.data.length} bytes, expected ${ROUND_SPACE}`);
  }
  const v = decode(acc.data);
  // Guards against a silently desynced offset table: a wrong offset would
  // still "decode", just to nonsense.
  if (v.id !== roundId) throw new Error(`decoded id ${v.id} != requested ${roundId}`);
  return v;
}

async function main() {
  console.log("═".repeat(78));
  console.log("B2 E2E — permissionless settlement on Solana DEVNET");
  console.log("═".repeat(78));
  console.log(`program  ${PROGRAM.toBase58()}`);
  console.log(`rpc      ${RPC}`);

  // ---- keys -------------------------------------------------------------
  const operator = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync("operator-devnet.key.json", "utf8")))
  );
  // The stranger persists so re-runs are comparable; it is a plain devnet
  // wallet with no special role anywhere.
  const stranger = existsSync(STRANGER_FILE)
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(STRANGER_FILE, "utf8"))))
    : (() => {
        const kp = Keypair.generate();
        writeFileSync(STRANGER_FILE, JSON.stringify(Array.from(kp.secretKey)));
        return kp;
      })();
  const wallets = JSON.parse(readFileSync(WALLETS_FILE, "utf8")) as {
    wallets: { label: string; pubkey: string; secret: number[]; deposit: number }[];
  };
  const depositors = wallets.wallets.map((w) => ({
    label: w.label,
    kp: Keypair.fromSecretKey(Uint8Array.from(w.secret)),
    deposit: BigInt(w.deposit),
  }));

  // ---- preconditions ----------------------------------------------------
  const cfg = (await connection.getAccountInfo(configPda(PROGRAM), "confirmed"))!.data;
  const configOperator = new PublicKey(cfg.subarray(8, 40));
  const treasuryOnChain = new PublicKey(cfg.subarray(40, 72));
  const feeBpsCfg = cfg.readUInt16LE(72);

  console.log(`\n── preconditions ──`);
  check("config.operator is the workspace operator", configOperator.equals(operator.publicKey));
  check("stranger is NOT the operator", !stranger.publicKey.equals(configOperator),
    `${stranger.publicKey.toBase58()} != ${configOperator.toBase58()}`);
  check("treasury unchanged", treasuryOnChain.equals(TREASURY), treasuryOnChain.toBase58());
  check("fee is 750 bps", feeBpsCfg === 750, `${feeBpsCfg}`);
  check("program id unchanged", PROGRAM.toBase58() === "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos");

  // Fund the stranger: it needs SOL ONLY for transaction fees.
  const FEE_BUDGET = 2_000_000n;
  const strangerBal = await connection.getBalance(stranger.publicKey, "confirmed");
  if (strangerBal < FEE_BUDGET) {
    const need = FEE_BUDGET - BigInt(strangerBal);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: operator.publicKey, blockhash, lastValidBlockHeight }).add(
      SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: stranger.publicKey, lamports: need })
    );
    tx.partialSign(operator);
    await sendAndConfirmTransaction(connection, tx, [operator], { commitment: "confirmed" });
  }
  const strangerFunded = await connection.getBalance(stranger.publicKey, "confirmed");
  check("stranger funded for fees", BigInt(strangerFunded) >= FEE_BUDGET, `${strangerFunded} lamports`);

  // ---- make sure every depositor can actually cover its stake ------------
  // A Participant account costs 1,163,320 lamports of rent on top of the
  // stake, so a wallet that won the previous round cannot necessarily cover
  // the next one. Fund any shortfall from the operator before depositing.
  {
    let refilled = 0;
    for (const d of depositors) {
      // stake + 1,163,320 participant rent + tx fee, with headroom
      const need = d.deposit + 5_000_000n;
      const bal = BigInt(await connection.getBalance(d.kp.publicKey, "confirmed"));
      if (bal >= need) continue;
      const top = need - bal;
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: operator.publicKey, blockhash, lastValidBlockHeight }).add(
        SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: d.kp.publicKey, lamports: top })
      );
      tx.partialSign(operator);
      await sendAndConfirmTransaction(connection, tx, [operator], { commitment: "confirmed" });
      const now = BigInt(await connection.getBalance(d.kp.publicKey, "confirmed"));
      if (now < need) throw new Error(`${d.label} still underfunded: ${now} < ${need}`);
      refilled++;
      console.log(`  funded ${d.label}: ${bal} -> ${now} lamports (stake ${d.deposit})`);
    }
    if (refilled === 0) console.log("  all depositors already funded");
  }

  // ---- create a round (still operator-only, by design) -------------------
  const counter = cfg.readBigUInt64LE(106);
  const roundId = counter + 1n;
  const roundKey = roundPda(PROGRAM, roundId);
  const escrowKey = escrowPda(PROGRAM, roundKey);
  console.log(`\n── stage 1: open round ${roundId} (tier ${TIER}) ──`);
  const createSig = await send(createRoundInstruction(PROGRAM, operator.publicKey, roundId, TIER), [operator], "create");
  let round = await readRound(roundId);
  check("round OPEN after create", round!.status === 0, `status=${STATUS[round!.status]} ${explorer(createSig)}`);

  // ---- deposits ---------------------------------------------------------
  console.log(`\n── stage 2: real deposits from 3 wallets ──`);
  const escrowRent = 650_240n;
  let escrowBal = await connection.getBalance(escrowKey, "confirmed");
  const depositSigs: string[] = [];
  for (const d of depositors) {
    const before = await connection.getBalance(escrowKey, "confirmed");
    const sig = await send(depositIx(PROGRAM, d.kp.publicKey, roundId, d.deposit), [d.kp], "deposit");
    depositSigs.push(sig);
    const after = await connection.getBalance(escrowKey, "confirmed");
    check(
      `${d.label}: escrow +${d.deposit}`,
      BigInt(after) - BigInt(before) === d.deposit,
      `${before} -> ${after}  ${explorer(sig)}`
    );
  }
  round = await readRound(roundId);
  check("pot equals tier cap", round!.pot === TIER_CAP, `${round!.pot}`);
  check("OPEN -> FULL", round!.status === 1, `status=${STATUS[round!.status]}`);

  // ---- stage 3: LOCK, signed by the STRANGER ----------------------------
  console.log(`\n── stage 3: lock_round signed by the NON-OPERATOR stranger ──`);
  const slotAtLock = await connection.getSlot("confirmed");
  const lockSig = await send(lockRoundIx(PROGRAM, stranger.publicKey, roundId), [stranger], "lock");
  round = await readRound(roundId);
  check("lock succeeded WITHOUT the operator key", round!.status === 3, `status=${STATUS[round!.status]} ${explorer(lockSig)}`);
  // The pre-send slot read can be well behind the slot the tx actually lands
  // in, so allow a generous window; the exact check is reveal_slot == +32.
  check("lock_slot recorded", round!.lockSlot >= BigInt(slotAtLock) && round!.lockSlot < BigInt(slotAtLock) + 60n,
    `lock_slot=${round!.lockSlot} (slot read before send: ${slotAtLock})`);
  check("reveal_slot = lock_slot + 32", round!.revealSlot === round!.lockSlot + 32n,
    `${round!.lockSlot} -> ${round!.revealSlot}`);
  check("fee frozen at 750 bps", round!.feeBps === 750, `${round!.feeBps}`);

  // ---- stage 4: forged-sysvar attack must be rejected --------------------
  console.log(`\n── stage 4: forged SlotHashes must be REJECTED (security pin) ──`);
  {
    // Attempt settle with the SlotHashes sysvar slot replaced by an ordinary,
    // attacker-controlled account. The program must reject it on the `address =`
    // constraint. This is the exact attack the pin exists to stop: before it,
    // a permissionless caller could pass a PDA full of
    // `(reveal_slot, hash-of-their-choosing)` bytes and pick the winner.
    //
    // Substituting a plain wallet is the strict form of the test: the program
    // must reject on the ADDRESS alone, before it ever looks at the contents.
    const participants = await loadParticipants(roundId, roundKey);
    const base = settleRoundIx(PROGRAM, stranger.publicKey, roundId, TREASURY, participants.map((p) => p.pda));
    const forgedAccount = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
    const ix = new TransactionInstruction({
      programId: PROGRAM,
      keys: base.keys.map((k, i) => (i === 5 ? { ...k, pubkey: forgedAccount } : k)),
      data: base.data,
    });
    let rejected = false;
    let errMsg = "";
    try {
      await send(ix, [stranger], "forged-sysvar");
    } catch (e) {
      rejected = true;
      errMsg = (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 170);
    }
    check("settle with a substituted slot_hashes account is REJECTED", rejected, errMsg || "IT WAS ACCEPTED");
    const after = await readRound(roundId);
    check("rejected attempt left the round untouched", after!.winner.equals(PublicKey.default),
      `winner=${after!.winner.toBase58()}`);
  }

  // ---- stage 5: SETTLE, signed by the STRANGER --------------------------
  console.log(`\n── stage 5: wait for reveal_slot, then settle as the NON-OPERATOR ──`);
  let slot = await connection.getSlot("confirmed");
  while (slot < Number(round!.revealSlot)) {
    await new Promise((r) => setTimeout(r, 1200));
    slot = await connection.getSlot("confirmed");
  }
  console.log(`  current slot ${slot} >= reveal_slot ${round!.revealSlot}`);
  const participants = await loadParticipants(roundId, roundKey);
  check("participant list complete", participants.length === round!.count, `${participants.length}/${round!.count}`);

  const potBeforeSettle = await connection.getBalance(escrowKey, "confirmed");
  // settle_round requires the participants in Participant.index order; the
  // program re-validates the chain, so any other order reverts.
  const settleSig = await send(
    settleRoundIx(PROGRAM, stranger.publicKey, roundId, TREASURY, participants.map((p) => p.pda)),
    [stranger],
    "settle"
  );
  round = await readRound(roundId);
  check("settle succeeded WITHOUT the operator key", round!.status === 3 && !round!.winner.equals(PublicKey.default),
    `status=${STATUS[round!.status]} winner=${round!.winner.toBase58()} ${explorer(settleSig)}`);
  check("settle moved no lamports", (await connection.getBalance(escrowKey, "confirmed")) === potBeforeSettle);
  check("persisted reveal_input recorded (B1 preserved)", !Buffer.from(round!.revealInput).equals(Buffer.alloc(32)),
    Buffer.from(round!.revealInput).toString("hex"));
  check("payout + fee == pot", round!.payout + round!.fee === round!.pot,
    `${round!.payout} + ${round!.fee} = ${round!.payout + round!.fee} vs pot ${round!.pot}`);

  // Independent B1 recompute from the persisted on-chain input.
  const rnd = deriveRandomness(Buffer.from(round!.revealInput), round!.id);
  const ticket = computeTicket(rnd, round!.pot);
  const entries = participants.map((p, i) => ({
    id: p.wallet.toBase58(),
    amount: p.amount,
    weightStart: p.weightStart,
    index: i,
  }));
  const independentWinner = selectWinner(entries, ticket);
  check("independent entropy == on-chain randomness",
    Buffer.from(rnd).toString("hex") === Buffer.from(round!.randomness).toString("hex"),
    Buffer.from(rnd).toString("hex").slice(0, 32) + "…");
  check("independent ticket == on-chain ticket", ticket === round!.ticket, `${ticket}`);
  check("independent winner == on-chain winner",
    independentWinner.id === round!.winner.toBase58(),
    `${independentWinner.id}`);

  // ---- stage 6: PAY, signed by the STRANGER -----------------------------
  console.log(`\n── stage 6: pay_winners signed by the NON-OPERATOR stranger ──`);
  const winnerBefore = await connection.getBalance(round!.winner, "confirmed");
  const treasuryBefore = await connection.getBalance(TREASURY, "confirmed");
  const escrowBeforePay = await connection.getBalance(escrowKey, "confirmed");
  const paySig = await send(
    payWinnersIx(PROGRAM, stranger.publicKey, roundId, round!.winner, TREASURY),
    [stranger],
    "pay"
  );
  const winnerAfter = await connection.getBalance(round!.winner, "confirmed");
  const treasuryAfter = await connection.getBalance(TREASURY, "confirmed");
  const escrowAfterPay = await connection.getBalance(escrowKey, "confirmed");
  round = await readRound(roundId);

  check("pay succeeded WITHOUT the operator key", round!.status === 5, `status=${STATUS[round!.status]} ${explorer(paySig)}`);
  check("winner received exactly 92.5%", BigInt(winnerAfter - winnerBefore) === round!.payout,
    `+${winnerAfter - winnerBefore} (expected +${round!.payout})`);
  check("treasury received exactly 7.5%", BigInt(treasuryAfter - treasuryBefore) === round!.fee,
    `+${treasuryAfter - treasuryBefore} (expected +${round!.fee})`);
  check("escrow reduced to rent floor", escrowAfterPay === 650_240, `${escrowBeforePay} -> ${escrowAfterPay}`);
  check("no funds created or lost",
    BigInt(winnerAfter - winnerBefore) + BigInt(treasuryAfter - treasuryBefore) === BigInt(escrowBeforePay - escrowAfterPay),
    `${winnerAfter - winnerBefore} + ${treasuryAfter - treasuryBefore} == ${escrowBeforePay - escrowAfterPay}`);
  check("92.5% / 7.5% split exact", round!.payout * 100n === round!.pot * 925n / 10n && round!.fee * 100n === round!.pot * 75n / 10n,
    `${round!.payout} / ${round!.fee} of ${round!.pot}`);

  // ---- stage 7: the operator is genuinely unnecessary -------------------
  console.log(`\n── stage 7: operator involvement audit ──`);
  const settleTx = await connection.getTransaction(settleSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const payTx = await connection.getTransaction(paySig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const lockTx = await connection.getTransaction(lockSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const signersOf = (t: Awaited<ReturnType<typeof connection.getTransaction>>): string[] => {
    if (!t) return [];
    // `message.accountKeys` is the plain ordered key list; the first
    // `numRequiredSignatures` entries are the signers.
    const keys = t.transaction.message.accountKeys as unknown as { toBase58(): string }[];
    return keys
      .slice(0, t.transaction.message.header.numRequiredSignatures)
      .map((k) => k.toBase58());
  };
  for (const [label, tx] of [["lock", lockTx], ["settle", settleTx], ["pay", payTx]] as const) {
    const s = signersOf(tx);
    check(`${label}: operator did NOT sign`,
      !s.includes(configOperator.toBase58()), s.length ? `signers: ${s.join(", ")}` : "no signers");
    check(`${label}: stranger signed`, s.includes(stranger.publicKey.toBase58()), s.join(", "));
  }

  // ---- record state -----------------------------------------------------
  const prev = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
  prev.permissionless = {
    roundId: roundId.toString(),
    tier: TIER,
    stranger: stranger.publicKey.toBase58(),
    operator: configOperator.toBase58(),
    createSig,
    depositSigs,
    lockSig,
    settleSig,
    paySig,
    revealSlot: round!.revealSlot.toString(),
    revealInput: Buffer.from(round!.revealInput).toString("hex"),
    randomness: Buffer.from(round!.randomness).toString("hex"),
    ticket: round!.ticket.toString(),
    winner: round!.winner.toBase58(),
    payout: round!.payout.toString(),
    fee: round!.fee.toString(),
    winnerDelta: winnerAfter - winnerBefore,
    treasuryDelta: treasuryAfter - treasuryBefore,
    escrowBefore: escrowBeforePay,
    escrowAfter: escrowAfterPay,
    status: STATUS[round!.status],
  };
  writeFileSync(STATE_FILE, JSON.stringify(prev, null, 2));

  console.log(`\n${"═".repeat(78)}`);
  console.log(failures === 0 ? "B2 E2E: ALL CHECKS PASSED" : `B2 E2E: ${failures} CHECK(S) FAILED`);
  console.log("═".repeat(78));
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Participant PDAs for the round, in the index order `settle_round` requires,
 * read straight from chain (weight at offset 72, weight_start at 80, index at
 * 96 — see PARTICIPANT_SPACE in programs/roulette/src/state.rs).
 */
interface Participant {
  wallet: PublicKey;
  pda: PublicKey;
  amount: bigint;
  weightStart: bigint;
  index: number;
}

async function loadParticipants(roundId: bigint, roundKey: PublicKey): Promise<Participant[]> {
  const round = await readRound(roundId);
  const wallets = JSON.parse(readFileSync(WALLETS_FILE, "utf8")) as { wallets: { pubkey: string }[] };
  // Resolve every wallet's Participant account ONCE, then order by the
  // on-chain `index` field. (Scanning per index and breaking on the first hit
  // would return the same wallet repeatedly.)
  const found: Participant[] = [];
  for (const w of wallets.wallets) {
    const wallet = new PublicKey(w.pubkey);
    const pda = participantPda(PROGRAM, roundKey, wallet);
    const acc = await connection.getAccountInfo(pda, "confirmed");
    if (!acc) continue;
    found.push({
      wallet,
      pda,
      amount: acc.data.readBigUInt64LE(72),
      weightStart: acc.data.readBigUInt64LE(80),
      index: acc.data.readUInt32LE(96),
    });
  }
  found.sort((a, b) => a.index - b.index);
  if (found.length !== round!.count) {
    throw new Error(`expected ${round!.count} participants, resolved ${found.length}`);
  }
  found.forEach((p, i) => {
    if (p.index !== i) throw new Error(`participant index gap at ${i} (got ${p.index})`);
  });
  return found;
}

main().catch((e) => {
  console.error("E2E crashed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
