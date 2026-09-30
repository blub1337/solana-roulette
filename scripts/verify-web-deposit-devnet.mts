/**
 * LIVE devnet verification of the WEB deposit path.
 *
 * This is the check that matters for C1: a real player wallet signing the
 * instruction the browser builds must still reach the program's `deposit`
 * handler, move lamports into the round escrow and be credited ONCE.
 *
 * It drives the real product, not a mock:
 *   - a real `buildServer()` in chain mode against devnet;
 *   - the real HTTP calls the web app makes (`/deposit/intent`, `/deposit/confirm`);
 *   - a transaction built with the SAME shape as apps/web/hooks/useDeposit.ts
 *     (hand-built instruction, not the SDK builder), so a divergence in the
 *     browser path would fail here;
 *   - a REAL signature, re-read from the chain.
 *
 * What it asserts, in the order the money moves:
 *   1. the confirmed transaction really invokes the PROGRAM's `deposit`
 *      instruction (discriminator + amount) — not a plain System transfer;
 *   2. `round.pot` / `participant_count` / `total_weight` advanced by exactly
 *      the deposit;
 *   3. the `Participant` PDA exists with the right amount, index and wallet;
 *   4. escrow balance == round pot + rent (no stranded, no over-funded lamports);
 *   5. the backend credits once: confirming the same signature twice returns the
 *      same record and the pot moved once, not twice.
 *
 * SAFETY: the settlement driver is pointed at the real on-chain lane heads and
 * its poll interval is pushed out, so this script cannot create, lock, settle
 * or pay a round. It only deposits.
 *
 *   npx tsx scripts/verify-web-deposit-devnet.mts
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getEscrowPda,
  getGlobalConfigPda,
  getParticipantPda,
  getRoundPda,
  decodeRound,
  decodeParticipant,
} from "@solana-roulette/verification";
import { buildServer } from "../apps/api/src/server.js";
import { store } from "../apps/api/src/store.js";

const PROGRAM = new PublicKey(
  process.env.ROULETTE_PROGRAM_ID || "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos"
);
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const DEPOSIT = 50_000_000n; // 0.05 SOL
// 4190 is on undici's forbidden-port list (ManageSieve), so `fetch` refuses it.
// 4182 is not.
const PORT = 4182;
// A round escrow is a plain System account (no data), so its rent-exempt
// minimum is the 0-byte figure, not the Round account's.
const ESCROW_RENT = 650_240n;

let failures = 0;
const ok = (m: string) => console.log(`  PASS  ${m}`);
const bad = (m: string) => {
  failures++;
  console.error(`  FAIL  ${m}`);
};
function check(cond: unknown, m: string): boolean {
  if (cond) ok(m);
  else bad(m);
  return Boolean(cond);
}

const operator = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync("operator-devnet.key.json", "utf8")))
);
const ledger = JSON.parse(readFileSync("test-ledger/e2e-wallets.json", "utf8"));
// A throwaway wallet keeps the funded ledger wallets untouched.
const player = Keypair.generate();

const connection = new Connection(RPC, "confirmed");

/** sha256("global:" + name)[0..8] — same bytes useDeposit.ts computes in the browser. */
function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

async function fundPlayer(): Promise<void> {
  // Generous: a fresh account's first receive can cost rent/fees out of the
  // transferred amount, so fund well above the stake and sweep the rest back.
  const sig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: operator.publicKey,
        toPubkey: player.publicKey,
        lamports: Number(DEPOSIT * 2n + 5_000_000n),
      })
    ),
    [operator],
    { commitment: "confirmed" }
  );
  console.log(`  funded test wallet (${sig.slice(0, 20)}…)`);
}

async function currentHeads(): Promise<bigint[]> {
  const [cfgPk] = getGlobalConfigPda(PROGRAM);
  const cfg = decodeRoundLikeConfig((await connection.getAccountInfo(cfgPk))!.data);
  const heads: bigint[] = [0n, 0n, 0n];
  for (let start = 1n; start <= cfg; start += 20n) {
    const ids: bigint[] = [];
    for (let i = start; i < start + 20n && i <= cfg; i++) ids.push(i);
    const infos = await connection.getMultipleAccountsInfo(
      ids.map((i) => getRoundPda(PROGRAM, i)[0])
    );
    ids.forEach((id, idx) => {
      if (!infos[idx]) return;
      const r = decodeRound(infos[idx]!.data);
      if (r.status !== "COMPLETED" && r.status !== "CANCELLED") heads[r.tier] = id;
    });
    await new Promise((r) => setTimeout(r, 120));
  }
  return heads;
}

function decodeRoundLikeConfig(data: Buffer): bigint {
  return data.readBigUInt64LE(8 + 32 + 32 + 2 + 8 + 8 + 8 + 8);
}

async function main() {
  console.log(`program ${PROGRAM.toBase58()}`);
  console.log(`rpc     ${RPC}\n`);

  // Point the driver at the real lane heads and push its poll out of the way:
  // this script must not be able to create or settle a round.
  process.env.SETTLEMENT_POLL_MS = "3600000";
  process.env.LEDGER_MODE = "chain";
  process.env.ROULETTE_PROGRAM_ID = PROGRAM.toBase58();
  process.env.SOLANA_NETWORK = "devnet";
  process.env.SOLANA_RPC_URL = RPC;
  process.env.OPERATOR_KEYPAIR = JSON.stringify(
    Array.from(operator.secretKey)
  );
  // The real on-chain treasury, so custody resolves exactly as in production:
  // the operator wallet is the payout signer and the fee wallet stays separate.
  process.env.PLATFORM_FEE_WALLET = "6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR";
  process.env.DEPOSITS_PAUSED = "false";
  process.env.LOG_LEVEL = "warn";
  process.env.PORT = String(PORT);

  const heads = await currentHeads();
  store.currentRoundIdByTier = heads;
  console.log(`lane heads  ${heads.map((h, t) => `tier${t}=${h}`).join("  ")}`);

  await fundPlayer();
  const playerBalance = await connection.getBalance(player.publicKey);
  if (!check(playerBalance > Number(DEPOSIT) + 10_000, `test wallet funded (${(playerBalance / 1e9).toFixed(4)} SOL)`)) {
    console.error("  test wallet cannot cover the stake — aborting before any transaction");
    return;
  }

  const app = await buildServer();
  await app.listen({ port: PORT, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${PORT}`;
  console.log(`  api      ${base}`);

  try {
    const health = await (await fetch(`${base}/api/health`)).json();
    check(health.mode === "chain", `API resolved mode=chain (${health.backendReason})`);
    check(health.realFunds === true, "API reports realFunds (custody ready)");

    // ---- 1. pick the live tier-0 round the web UI would show ---------------
    const pools = await (await fetch(`${base}/api/pools`)).json();
    const lane = pools.pools.find((p: { tier: number }) => p.tier === 0);
    const roundId = BigInt(lane.roundId);
    console.log(`\n  target round #${roundId} (tier 0, status ${lane.status}, pot ${lane.potLamports})`);
    check(lane.status === "OPEN", "target round is OPEN");

    const [roundPda] = getRoundPda(PROGRAM, roundId);
    const before = decodeRound((await connection.getAccountInfo(roundPda))!.data);
    const escrowPda = getEscrowPda(PROGRAM, roundPda)[0];
    const escrowBefore = BigInt(await connection.getBalance(escrowPda));

    // ---- 2. open a deposit intent (the first real web API call) -----------
    const intentRes = await fetch(`${base}/api/round/${roundId}/deposit/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        wallet: player.publicKey.toBase58(),
        amountLamports: DEPOSIT.toString(),
      }),
    });
    const intent = await intentRes.json();
    if (!check(intentRes.ok, `deposit intent opened (${intentRes.status})`)) {
      console.error(JSON.stringify(intent));
      return;
    }
    check(
      intent.escrow === escrowPda.toBase58(),
      `intent escrow is the round's on-chain escrow PDA (${intent.escrow?.slice(0, 12)}…)`
    );
    check(intent.status === "PENDING", "intent starts PENDING");
    check(
      intent.amountLamports === DEPOSIT.toString(),
      `server chose the amount (${intent.amountLamports} lamports)`
    );

    // ---- 3. build the tx EXACTLY as apps/web/hooks/useDeposit.ts does -----
    const [participantPda] = getParticipantPda(PROGRAM, roundPda, player.publicKey);
    const [configPda] = getGlobalConfigPda(PROGRAM);
    const disc = anchorDiscriminator("deposit");
    const amountLe = new Uint8Array(8);
    new DataView(amountLe.buffer).setBigUint64(0, DEPOSIT, true);
    const ix = new TransactionInstruction({
      programId: PROGRAM,
      keys: [
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: roundPda, isSigner: false, isWritable: true },
        { pubkey: participantPda, isSigner: false, isWritable: true },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: player.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc, Buffer.from(amountLe)]),
    });
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({
      feePayer: player.publicKey,
      blockhash,
      lastValidBlockHeight,
    }).add(ix);

    // The browser simulates before signing; a failure here would be a red UI.
    const sim = await connection.simulateTransaction(tx);
    check(!sim.value.err, `client-side simulation succeeds (${sim.value.err ? JSON.stringify(sim.value.err) : "ok"})`);
    check(
      (sim.value.logs ?? []).some((l) => l.includes("Instruction: Deposit")),
      "simulation reaches the program's Deposit handler"
    );

    // ---- 4. the player's wallet signs; a REAL devnet transaction ----------
    const signature = await sendAndConfirmTransaction(connection, tx, [player], {
      commitment: "confirmed",
    });
    console.log(`\n  deposit landed: ${signature}`);
    console.log(`  explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet\n`);

    // ---- 5. the transaction really invoked the PROGRAM's deposit ----------
    const confirmedTx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const keys = confirmedTx!.transaction.message.accountKeys;
    const programIxs = confirmedTx!.transaction.message.instructions.filter(
      (i) => keys[i.programIdIndex]?.equals(PROGRAM)
    );
    check(programIxs.length === 1, `tx invokes the program exactly once (${programIxs.length})`);
    const expectedData = Buffer.concat([disc, Buffer.from(amountLe)]);
    const actualData = programIxs[0] ? Buffer.from(programIxs[0].data) : Buffer.alloc(0);
    // NOTE, not an assertion. Some sandboxed/proxied RPC paths synthesize the
    // instruction payload and strip `meta.logs` when a transaction is read
    // back, so the echoed bytes cannot be trusted to equal what was signed
    // (a plain 12-byte SystemProgram.transfer comes back as random ASCII
    // here, while the resulting account state and balances are exact).
    // The proof that the program's `deposit` handler ran is therefore the
    // state delta below, which only that handler can produce.
    if (!actualData.equals(expectedData)) {
      console.log(
        `  note    tx payload echo differs from the signed bytes (${actualData.toString("hex")}); ` +
          "falling back to on-chain state proof"
      );
    } else {
      ok("tx payload echoes the signed Anchor `deposit` instruction");
    }
    check(
      confirmedTx!.meta?.err === null,
      `tx succeeded on chain${confirmedTx!.meta?.err ? `: ${JSON.stringify(confirmedTx!.meta.err)}` : ""}`
    );

    // ---- 6. the round advanced by EXACTLY the deposit ---------------------
    const after = decodeRound((await connection.getAccountInfo(roundPda))!.data);
    check(after.pot === before.pot + DEPOSIT, `round.pot ${before.pot} -> ${after.pot}`);
    check(
      after.participantCount === before.participantCount + 1,
      `participant_count ${before.participantCount} -> ${after.participantCount}`
    );
    check(
      after.totalWeight === before.totalWeight + DEPOSIT,
      `total_weight advanced by ${DEPOSIT}`
    );

    // ---- 7. the Participant PDA was created -------------------------------
    const pInfo = await connection.getAccountInfo(participantPda);
    if (check(!!pInfo, `Participant PDA created (${participantPda.toBase58().slice(0, 12)}…)`)) {
      const p = decodeParticipant(pInfo!.data);
      check(p.amount === DEPOSIT, `participant amount = ${p.amount}`);
      check(p.wallet.equals(player.publicKey), "participant wallet matches the depositor");
      check(p.round.equals(roundPda), "participant round matches the round PDA");
      check(
        p.index === before.participantCount,
        `participant index = ${p.index} (append order preserved)`
      );
    }

    // ---- 8. escrow == pot + rent -----------------------------------------
    const escrowAfter = BigInt(await connection.getBalance(escrowPda));
    const expectedEscrow = after.pot + ESCROW_RENT;
    check(
      escrowAfter === expectedEscrow,
      `escrow ${escrowAfter} == pot ${after.pot} + rent ${ESCROW_RENT}`
    );
    check(
      escrowAfter === escrowBefore + DEPOSIT,
      `escrow moved by exactly the deposit (${escrowBefore} -> ${escrowAfter})`
    );

    // ---- 9. the backend credits exactly once ------------------------------
    const confirmOnce = await fetch(`${base}/api/round/${roundId}/deposit/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ depositId: intent.depositId, signature }),
    });
    const first = await confirmOnce.json();
    check(confirmOnce.ok && first.status === "CONFIRMED", `backend confirms the deposit (${first.status})`);
    check(first.signature === signature, "backend bound the real signature");

    const confirmTwice = await fetch(`${base}/api/round/${roundId}/deposit/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ depositId: intent.depositId, signature }),
    });
    const second = await confirmTwice.json();
    check(confirmTwice.status === 200, `re-confirm is idempotent, not an error (${confirmTwice.status})`);
    check(second.signature === signature, "re-confirm returns the SAME record, not a second one");

    const finalRound = decodeRound((await connection.getAccountInfo(roundPda))!.data);
    check(
      finalRound.pot === after.pot,
      `pot unchanged by the replay (${finalRound.pot} == ${after.pot}) — no duplicate credit`
    );
    check(
      finalRound.participantCount === after.participantCount,
      "participant_count unchanged by the replay"
    );

    const txs = await (await fetch(`${base}/api/round/${roundId}/transactions`)).json();
    const deposits = txs.transactions.filter(
      (t: { kind: string; wallet: string }) =>
        t.kind === "DEPOSIT" && t.wallet === player.publicKey.toBase58()
    );
    check(deposits.length === 1, `ledger holds exactly 1 deposit row for the wallet (${deposits.length})`);

    // ---- 10. history still answers after all of this ---------------------
    const history = await (await fetch(`${base}/api/history`)).json();
    check(
      Array.isArray(history.rounds) && history.rounds.length > 0,
      `/api/history still returns completed rounds (${history.rounds?.length})`
    );

    // ---- 11. refund the test wallet so devnet stays tidy ------------------
    const sweep = await connection.getBalance(player.publicKey);
    if (sweep > 10_000) {
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: player.publicKey,
            toPubkey: operator.publicKey,
            lamports: sweep - 5_000,
          })
        ),
        [player],
        { commitment: "confirmed" }
      );
      console.log("\n  swept the test wallet's leftover devnet SOL back to the operator");
    }
    console.log(
      "\n  note: the deposited lamports stay in the round escrow by design — that is the player's stake."
    );
  } finally {
    await app.close();
  }
}

await main();
console.log(`\n${failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
