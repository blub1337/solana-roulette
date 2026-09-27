// Real devnet MagicBlock VRF request against the throwaway spike program.
//
// NO SIMULATION: this submits a real transaction, then waits for the real
// oracle to submit the real fulfillment transaction, then reads the randomness
// back out of the state account the callback wrote. If the callback never
// lands, this exits non-zero. No value is ever fabricated locally.
//
//   node scripts/vrf-spike-request.mjs --program <ID> --keypair <path>
//        [--lane regular|high_priority|both] [--timeout ms]
//
// Never prints key material: only public keys, signatures, balances and logs.

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import fs from "node:fs";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const VRF_PROGRAM = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const QUEUE = new PublicKey("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");
const GLOBAL_IDENTITY = new PublicKey("9irBy75QS2BN81FUgXuHcjqceJJRuc9oDkAe8TKVvvAw");
const SLOT_HASHES = new PublicKey("SysvarS1otHashes111111111111111111111111111");
const LAMPORTS_PER_SOL = 1_000_000_000;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PROGRAM_ID = new PublicKey(arg("program"));
const KEYPAIR_PATH = arg("keypair", "operator-devnet.key.json");
const LANE = arg("lane", "both");
const TIMEOUT_MS = Number(arg("timeout", "240000"));

const disc = (m) => createHash("sha256").update(`global:${m}`).digest().subarray(0, 8);

const [state] = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);
const [programIdentity] = PublicKey.findProgramAddressSync(
  [Buffer.from("identity")],
  PROGRAM_ID,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(fn, label, tries = 10) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (i === tries - 1) throw new Error(`${label} failed after ${tries} tries: ${msg}`);
      if (/429|Too Many|timeout|ECONN|fetch failed|socket/i.test(msg)) {
        await sleep(1200 * (i + 1));
        continue;
      }
      throw e;
    }
  }
}

/** 8 disc + 4 req + 4 ful + 1 seed + 1 lane + 1 roll + 1 fulfilled + 32 rnd + 1 bump */
function decodeState(buf) {
  return {
    request_count: buf.readUInt32LE(8),
    fulfill_count: buf.readUInt32LE(12),
    client_seed: buf.readUInt8(16),
    last_lane: buf.readUInt8(17),
    roll: buf.readUInt8(18),
    fulfilled: buf.readUInt8(19),
    randomness: buf.subarray(20, 52).toString("hex"),
    bump: buf.readUInt8(52),
  };
}

function initIx(payer) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: state, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc("init"),
  });
}

function requestIx(payer, method, seed) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    // Order mirrors RequestCtx: payer, oracle_queue, state, then the four
    // fields `#[vrf]` appends: program_identity, vrf_program, slot_hashes,
    // system_program.
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: QUEUE, isSigner: false, isWritable: true },
      { pubkey: state, isSigner: false, isWritable: true },
      { pubkey: programIdentity, isSigner: false, isWritable: false },
      { pubkey: VRF_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SLOT_HASHES, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc(method), Buffer.from([seed])]),
  });
}

async function confirm(c, sig) {
  for (let i = 0; i < 40; i++) {
    const s = await rpc(() => c.getSignatureStatus(sig, { searchTransactionHistory: true }), "status");
    if (s?.value?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(s.value.err)}`);
    if (s?.value?.confirmationStatus === "confirmed" || s?.value?.confirmationStatus === "finalized") {
      const tx = await rpc(
        () => c.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }),
        "tx",
      );
      if (tx) return tx;
    }
    await sleep(1500);
  }
  throw new Error(`tx ${sig} never confirmed`);
}

async function send(c, payer, ix, label) {
  const bh = await rpc(() => c.getLatestBlockhash("confirmed"), "blockhash");
  const tx = new Transaction({
    feePayer: payer.publicKey,
    blockhash: bh.blockhash,
    lastValidBlockHeight: bh.lastValidBlockHeight,
  });
  tx.add(ix);
  const sig = await rpc(
    () => c.sendTransaction(tx, payer, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 5 }),
    label,
  );
  return { sig, tx: await confirm(c, sig) };
}

async function waitForCallback(c, statePda, afterSig) {
  const deadline = Date.now() + TIMEOUT_MS;
  const seen = new Set([afterSig]);
  while (Date.now() < deadline) {
    let sigs = [];
    try {
      sigs = await rpc(() => c.getSignaturesForAddress(statePda, { limit: 20 }), "sigs");
    } catch {
      await sleep(2000);
      continue;
    }
    for (const s of sigs) {
      if (seen.has(s.signature) || s.err) continue;
      seen.add(s.signature);
      let tx;
      try {
        tx = await rpc(
          () => c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }),
          "cb",
        );
      } catch {
        continue;
      }
      if (!tx) continue;
      if ((tx.meta?.logMessages ?? []).some((l) => l.includes("VrfSpikeConsume"))) {
        return { sig: s.signature, tx };
      }
    }
    await sleep(2000);
  }
  return null;
}

/** Which account signed the callback CPI? Must be the VRF_PROGRAM_IDENTITY. */
function identityCheck(cbTx) {
  const keys = cbTx.transaction.message.accountKeys.map((k) =>
    typeof k === "string" ? k : typeof k.toBase58 === "function" ? k.toBase58() : k.pubkey.toBase58(),
  );
  for (const inner of cbTx.meta.innerInstructions ?? []) {
    for (const i of inner.instructions) {
      const pid =
        typeof i.programId?.toBase58 === "function" ? i.programId.toBase58() : keys[i.programIdIndex];
      if (pid !== PROGRAM_ID.toBase58()) continue;
      const a0 = i.accounts?.[0];
      const addr = typeof a0 === "number" ? keys[a0] : (a0?.pubkey?.toBase58?.() ?? "?");
      const isSigner = typeof a0 === "number" ? null : a0.isSigner;
      return {
        callback_account0: addr,
        is_signer: isSigner,
        expected: GLOBAL_IDENTITY.toBase58(),
        matches_expected: addr === GLOBAL_IDENTITY.toBase58() && isSigner === true,
      };
    }
  }
  return { callback_account0: null, note: "callback CPI not found in inner instructions" };
}

function perProgramCu(tx) {
  const out = [];
  for (const l of tx.meta.logMessages ?? []) {
    const m = l.match(/^Program (\S+) consumed (\d+) of (\d+) compute units/);
    if (m) out.push({ program: m[1], cu: Number(m[2]), budget: Number(m[3]) });
  }
  return out;
}

function cuBreakdown(tx) {
  // The last "consumed X of Y" line for a program is that program's total,
  // inclusive of its CPIs. Proof-verification cost = VRF program total minus
  // what the callback reported it consumed.
  const entries = perProgramCu(tx);
  const ours = entries.filter((e) => e.program === PROGRAM_ID.toBase58()).pop();
  const vrf = entries.filter((e) => e.program === VRF_PROGRAM.toBase58()).pop();
  return {
    entries,
    callback_cu: ours?.cu ?? null,
    callback_budget: ours?.budget ?? null,
    vrf_program_total_cu: vrf?.cu ?? null,
    implied_proof_verification_cu:
      vrf && ours ? vrf.cu - ours.cu : null,
  };
}

async function main() {
  const c = new Connection(RPC, "confirmed");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"))),
  );

  console.log(`program:      ${PROGRAM_ID.toBase58()}`);
  console.log(`payer:        ${payer.publicKey.toBase58()}`);
  console.log(`queue:        ${QUEUE.toBase58()}`);
  console.log(`vrf program:  ${VRF_PROGRAM.toBase58()}`);
  console.log(`state:        ${state.toBase58()}`);
  console.log(`identity pda: ${programIdentity.toBase58()}`);
  console.log(`global idty:  ${GLOBAL_IDENTITY.toBase58()}`);

  const lanes =
    LANE === "both" ? ["regular", "high_priority"] : [LANE];
  const results = [];

  const existing = await rpc(() => c.getAccountInfo(state, { commitment: "confirmed" }), "state");
  if (!existing) {
    const { sig, tx } = await send(c, payer, initIx(payer.publicKey), "init");
    console.log(`init tx: ${sig}`);
    if (tx.meta.err) throw new Error(`init failed: ${JSON.stringify(tx.meta.err)}`);
  } else {
    console.log("init: already present");
  }

  const queueBefore = (await rpc(() => c.getAccountInfo(QUEUE, { commitment: "confirmed" }), "q")).lamports;
  let seed = 41;

  for (const lane of lanes) {
    const method = `request_${lane}`;
    const before = await rpc(() => c.getBalance(payer.publicKey), "bal");
    const queueAtRequest = (await rpc(() => c.getAccountInfo(QUEUE, { commitment: "confirmed" }), "q")).lamports;

    console.log(`\n--- lane=${lane}: sending a REAL RequestRandomness ---`);
    const t0 = Date.now();
    const req = await send(c, payer, requestIx(payer.publicKey, method, seed), method);
    console.log(`request tx:  ${req.sig}`);
    console.log(`             slot ${req.tx.slot}, cu ${req.tx.meta.computeUnitsConsumed}, fee ${req.tx.meta.fee} lamports`);
    for (const l of req.tx.meta.logMessages) console.log(`  | ${l}`);
    if (req.tx.meta.err) throw new Error(`request failed: ${JSON.stringify(req.tx.meta.err)}`);

    const afterRequest = await rpc(() => c.getBalance(payer.publicKey), "bal");
    const queueAfterRequest = (await rpc(() => c.getAccountInfo(QUEUE, { commitment: "confirmed" }), "q")).lamports;
    console.log(
      `request cost: ${before.lamports - afterRequest.lamports} lamports ` +
        `(${(before.lamports - afterRequest.lamports) / LAMPORTS_PER_SOL} SOL); ` +
        `queue delta ${queueAfterRequest - queueAtRequest} lamports`,
    );

    console.log(`waiting for the REAL fulfillment (timeout ${TIMEOUT_MS}ms)...`);
    const cb = await waitForCallback(c, state, req.sig);

    if (!cb) {
      console.error(`lane ${lane}: NOT FULFILLED within ${TIMEOUT_MS}ms`);
      results.push({
        lane,
        fulfilled: false,
        request_tx: req.sig,
        request_cost_sol: (before.lamports - afterRequest.lamports) / LAMPORTS_PER_SOL,
      });
      seed += 1;
      continue;
    }

    const cu = cuBreakdown(cb.tx);
    const wall = (Date.now() - t0) / 1000;
    console.log(`\n--- lane=${lane}: REAL FULFILLMENT ---`);
    console.log(`fulfillment: ${cb.sig}`);
    console.log(`             slot ${cb.tx.slot}, total cu ${cb.tx.meta.computeUnitsConsumed}, fee ${cb.tx.meta.fee} lamports`);
    console.log(`             ${wall.toFixed(1)}s wall / ${cb.tx.slot - req.tx.slot} slots after the request`);
    console.log(`             callback cu ${cu.callback_cu} (budget ${cu.callback_budget}), proof verification ~${cu.implied_proof_verification_cu} cu`);
    for (const l of cb.tx.meta.logMessages) console.log(`  | ${l}`);

    const queueAtFulfill = (await rpc(() => c.getAccountInfo(QUEUE, { commitment: "confirmed" }), "q")).lamports;
    const acc = await rpc(() => c.getAccountInfo(state, { commitment: "confirmed" }), "state2");
    const st = decodeState(acc.data);
    console.log(`state on-chain: ${JSON.stringify(st)}`);

    const idc = identityCheck(cb.tx);
    console.log(`identity check: ${JSON.stringify(idc)}`);

    results.push({
      lane,
      fulfilled: true,
      program_id: PROGRAM_ID.toBase58(),
      payer: payer.publicKey.toBase58(),
      client_seed: seed,
      request_tx: req.sig,
      request_slot: req.tx.slot,
      request_cu: req.tx.meta.computeUnitsConsumed,
      request_fee_lamports: req.tx.meta.fee,
      request_cost_lamports: before.lamports - afterRequest.lamports,
      request_cost_sol: (before.lamports - afterRequest.lamports) / LAMPORTS_PER_SOL,
      queue_deposit_lamports: queueAfterRequest - queueAtRequest,
      queue_release_lamports: queueAfterRequest - queueAtFulfill,
      queue_balance_delta_over_lane: queueAtFulfill - queueAtRequest,
      queue_balance_at_start: queueBefore,
      queue_balance_at_end: queueAtFulfill,
      fulfillment_tx: cb.sig,
      fulfillment_slot: cb.tx.slot,
      latency_slots: cb.tx.slot - req.tx.slot,
      latency_wall_seconds: wall,
      fulfillment_cu_total: cb.tx.meta.computeUnitsConsumed,
      fulfillment_fee_lamports: cb.tx.meta.fee,
      callback_cu: cu.callback_cu,
      callback_cu_budget: cu.callback_budget,
      implied_proof_verification_cu: cu.implied_proof_verification_cu,
      per_program_cu: cu.entries,
      state_after: st,
      identity_check: idc,
    });
    seed += 1;
  }

  console.log("\n###VRF-SPIKE-RESULT###");
  console.log(JSON.stringify({ program_id: PROGRAM_ID.toBase58(), results }, null, 2));
  console.log("###END###");

  if (!results.every((r) => r.fulfilled)) process.exit(2);
}

main().catch((e) => {
  console.error("SPIKE FAILED:", e?.message ?? e);
  process.exit(1);
});
