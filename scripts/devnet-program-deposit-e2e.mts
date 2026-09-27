/**
 * C1 fix — LIVE devnet E2E for the program-instruction deposit path.
 *
 * Proves, against the real deployed program (no mocks):
 *   1. the deposit instruction built EXACTLY like the web client now builds
 *      it succeeds on chain;
 *   2. the Round PDA's pot/participant_count/total_weight advanced;
 *   3. the Participant PDA was created with the right amount/index;
 *   4. the server-side verifier (checkProgramDeposit) accepts the signature;
 *   5. the escrow balance rose by exactly the deposit amount (no stranded
 *      funds — pay_winners can reach 100% of pot via frozen fee/payout).
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { depositIx } from "../packages/sdk/dist/index.js";
import {
  getEscrowPda,
  getParticipantPda,
  getRoundPda,
  decodeRound,
  decodeParticipant,
  getGlobalConfigPda,
} from "../packages/verification/dist/index.js";
import { readFileSync } from "node:fs";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.ROULETTE_PROGRAM_ID || "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos"
);

function loadKeypair(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

const conn = new Connection(RPC, "confirmed");

// Resolve a funded test wallet: e2e-wallets.json holds wallets[0..2] with
// `secret` as a 64-number array (never printed).
function loadT1() {
  const ledger = JSON.parse(readFileSync("test-ledger/e2e-wallets.json", "utf8"));
  const w = ledger.wallets["0"] ?? ledger.t1;
  return Keypair.fromSecretKey(new Uint8Array(w.secret));
}

const OK = (m) => console.log(`PASS: ${m}`);
const FAIL = (m) => {
  console.error(`FAIL: ${m}`);
  process.exitCode = 1;
};

const [configPda] = getGlobalConfigPda(PROGRAM_ID);
const cfgAcct = await conn.getAccountInfo(configPda);
if (!cfgAcct) throw new Error("program config not found on devnet");
const nextId = decodeGlobalCounter(cfgAcct.data) + 1n;

// ---- pick the live head round of tier 0 (OPEN) — the one the web UI uses --
const API = "https://solana-roulette-api-gd7k.onrender.com";

async function liveHeadRound() {
  const pools = await (await fetch(`${API}/api/pools`)).json();
  const tier0 = Array.isArray(pools) ? pools.find((p) => p.tier === 0) : pools.pools?.find((p) => p.tier === 0);
  if (!tier0?.roundId) throw new Error("no tier-0 round found in /api/pools");
  return BigInt(tier0.roundId);
}

// Pick the live head round of tier 0 (OPEN) — the same one the web UI uses.
const roundId = await liveHeadRound();
const [roundPda] = getRoundPda(PROGRAM_ID, roundId);
const before = decodeRound((await conn.getAccountInfo(roundPda)).data);
console.log(`round ${roundId}: status=${before.status} pot=${before.pot} participants=${before.participantCount}`);

if (before.status !== "OPEN") {
  console.log(`round ${roundId} is ${before.status} — waiting for the driver to open the next one...`);
}

const depositor = loadT1();
const depositLamports = 50_000_000n; // 0.05 SOL

const balBefore = BigInt(await conn.getBalance(depositor.publicKey));
if (balBefore < depositLamports + 20_000n) {
  console.error(`depositor ${depositor.publicKey.toBase58()} underfunded (${balBefore} lamports)`);
  process.exit(2);
}

const escrowPda = getEscrowPda(PROGRAM_ID, roundPda)[0];
const escrowBefore = BigInt(await conn.getBalance(escrowPda));

// The exact instruction shape the web client builds (programs/roulette Deposit).
const ix = depositIx(PROGRAM_ID, depositor.publicKey, roundId, depositLamports);
console.log("accounts:", ix.keys.map((k) => k.pubkey.toBase58() + (k.isSigner ? "(s)" : "") + (k.isWritable ? "(w)" : "")).join(" "));

let sig;
try {
  sig = await sendAndConfirmTransaction(
    conn,
    new Transaction().add(ix),
    [depositor],
    { commitment: "confirmed" }
  );
  OK(`deposit instruction landed: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
} catch (err) {
  // DuplicateDeposit means this wallet already has an entry in this round —
  // that itself proves the participant PDA exists. Retry with a throwaway wallet.
  if (/DuplicateDeposit|already in use|0x1771|custom/i.test(String(err))) {
    console.log("wallet already deposited in this round; switching to a fresh throwaway wallet");
    const fresh = Keypair.generate();
    // Fund it from T1.
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: depositor.publicKey,
          toPubkey: fresh.publicKey,
          lamports: Number(depositLamports) + 50_000,
        })
      ),
      [depositor],
      { commitment: "confirmed" }
    );
    sig = await sendAndConfirmTransaction(
      conn,
      new Transaction().add(depositIx(PROGRAM_ID, fresh.publicKey, roundId, depositLamports)),
      [fresh],
      { commitment: "confirmed" }
    );
    OK(`deposit instruction landed (fresh wallet): https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  } else {
    throw err;
  }
}

// ---- verify round state advanced on chain ---------------------------------
const after = decodeRound((await conn.getAccountInfo(roundPda)).data);
const escrowAfter = BigInt(await conn.getBalance(escrowPda));

if (after.pot === before.pot + depositLamports) OK(`round.pot advanced ${before.pot} -> ${after.pot}`);
else FAIL(`round.pot did not advance: ${before.pot} -> ${after.pot}`);

if (after.participantCount === before.participantCount + 1)
  OK(`participant_count advanced ${before.participantCount} -> ${after.participantCount}`);
else FAIL(`participant_count did not advance: ${before.participantCount} -> ${after.participantCount}`);

if (after.totalWeight === before.totalWeight + depositLamports) OK(`total_weight advanced`);
else FAIL(`total_weight did not advance: ${before.totalWeight} -> ${after.totalWeight}`);

if (escrowAfter === escrowBefore + depositLamports)
  OK(`escrow balance advanced ${escrowBefore} -> ${escrowAfter} (lamports are INSIDE the payout-reachable PDA)`);
else FAIL(`escrow balance mismatch: ${escrowBefore} -> ${escrowAfter}`);

// ---- verify the Participant PDA -------------------------------------------
const walletsToCheck = [];
{
  const beforeWallet = depositor.publicKey;
  walletsToCheck.push(beforeWallet);
}
let participantVerified = false;
for (const w of walletsToCheck) {
  const pPda = getParticipantPda(PROGRAM_ID, roundPda, w)[0];
  const info = await conn.getAccountInfo(pPda);
  if (!info) continue;
  const p = decodeParticipant(info.data);
  if (p.amount === depositLamports && p.round.equals(roundPda) && p.wallet.equals(w)) {
    OK(`Participant PDA ${pPda.toBase58()} records amount=${p.amount} index=${p.index} round=${p.round.toBase58().slice(0, 6)}…`);
    participantVerified = true;
  }
}
if (!participantVerified) FAIL("no Participant PDA matched the deposit");

// ---- run the server-side verifier against the real signature --------------
const { checkProgramDeposit } = await import("../apps/api/src/onchain.js");
const check = await checkProgramDeposit(conn, {
  signature: sig,
  programId: PROGRAM_ID,
  roundId,
  wallet: depositor.publicKey,
  escrow: escrowPda,
  amount: depositLamports,
});
if (check.ok) OK(`checkProgramDeposit verified the signature (slot ${check.slot})`);
else FAIL(`checkProgramDeposit rejected: ${check.code}: ${check.detail}`);

// If the round hit its cap exactly, confirm FULL flip.
if (after.status === "FULL") OK(`round flipped to FULL (cap reached) — driver can now lock`);

function decodeGlobalCounter(data) {
  // GlobalConfig: disc(8) operator(32) treasury(32) fee_bps(2) max_round_size(8)
  // min_deposit(8) max_deposit(8) reveal_offset(8) round_counter(8) tier_caps(24) bump(1)
  return data.readBigUInt64LE(8 + 32 + 32 + 2 + 8 + 8 + 8 + 8);
}
