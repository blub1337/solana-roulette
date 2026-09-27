// Real devnet MagicBlock VRF request against the throwaway spike program.
//
// This performs NO simulation: it submits a real transaction, then waits for
// the real oracle to submit the real fulfillment transaction, then reads the
// randomness back out of the state account the callback wrote. Nothing here
// fabricates a value; if the callback never lands, this exits non-zero.
//
// Usage:
//   node scripts/vrf-spike-request.mjs --program <ID> --keypair <path> [--lane scoped|legacy|both]
//
// Never prints key material. Only public keys, signatures and logs.

import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
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
const LANE = arg("lane", "scoped");
const TIMEOUT_MS = Number(arg("timeout", "240000"));

const disc = (m) => createHash("sha256").update(`global:${m}`).digest().subarray(0, 8);

const [stateScoped] = PublicKey.findProgramAddressSync([Buffer.from("state_s")], PROGRAM_ID);
const [stateLegacy] = PublicKey.findProgramAddressSync([Buffer.from("state_l")], PROGRAM_ID);
const [programIdentity] = PublicKey.findProgramAddressSync([Buffer.from("identity")], PROGRAM_ID);
const [scopedIdentity] = PublicKey.findProgramAddressSync(
  [Buffer.from("identity"), PROGRAM_ID.toBuffer()],
  VRF_PROGRAM,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(fn, label, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (i === tries - 1) throw new Error(`${label} failed after ${tries} tries: ${msg}`);
      if (/429|Too Many|timeout|ECONN|fetch failed/i.test(msg)) {
        await sleep(1200 * (i + 1));
        continue;
      }
      throw e;
    }
  }
}

function decodeState(buf) {
  // 8 disc + 4 req + 4 ful + 1 seed + 1 roll + 1 fulfilled + 32 rnd + 1 bump
  return {
    request_count: buf.readUInt32LE(8),
    fulfill_count: buf.readUInt32LE(12),
    client_seed: buf.readUInt8(16),
    roll: buf.readUInt8(17),
    fulfilled: buf.readUInt8(18),
    randomness: [...buf.subarray(19, 51)].map((b) => b.toString(16).padStart(2, "0")).join(""),
    bump: buf.readUInt8(51),
  };
}

function initIx(payer) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: stateScoped, isSigner: false, isWritable: true },
      { pubkey: stateLegacy, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc("init"),
  });
}

function requestScopedIx(payer, seed) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    // Order mirrors RequestScopedCtx: payer, oracle_queue, state, then the
    // four fields `#[vrf]` appends: program_identity, vrf_program,
    // slot_hashes, system_program.
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: QUEUE, isSigner: false, isWritable: true },
      { pubkey: stateScoped, isSigner: false, isWritable: true },
      { pubkey: programIdentity, isSigner: false, isWritable: false },
      { pubkey: VRF_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SLOT_HASHES, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("request_scoped"), Buffer.from([seed])]),
  });
}

function requestLegacyIx(payer, seed) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: programIdentity, isSigner: false, isWritable: false },
      { pubkey: QUEUE, isSigner: false, isWritable: true },
      { pubkey: stateLegacy, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SLOT_HASHES, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("request_legacy"), Buffer.from([seed])]),
  });
}

async function send(c, payer, ix, label) {
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash: (await rpc(() => c.getLatestBlockhash("confirmed"), "blockhash")).blockhash, lastValidBlockHeight: 0 });
  tx.add(ix);
  const sig = await rpc(() => c.sendTransaction(tx, payer, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 5 }), label);
  const meta = await rpc(() => rpcWait(c, sig), `${label} confirm`);
  return { sig, meta };
}

async function rpcWait(c, sig) {
  for (let i = 0; i < 40; i++) {
    const s = await rpc(() => c.getSignatureStatus(sig, { searchTransactionHistory: true }), "status");
    if (s?.value?.confirmationStatus === "confirmed" || s?.value?.err === null) {
      const tx = await rpc(() => c.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }), "tx");
      if (tx) return tx;
    }
    if (s?.value?.err) {
      throw new Error(`tx ${sig} failed: ${JSON.stringify(s.value.err)}`);
    }
    await sleep(1500);
  }
  throw new Error(`tx ${sig} never confirmed`);
}

async function waitForCallback(c, statePda, afterSig, lane) {
  const deadline = Date.now() + TIMEOUT_MS;
  const seen = new Set();
  while (Date.now() < deadline) {
    let sigs = [];
    try {
      sigs = await rpc(() => c.getSignaturesForAddress(statePda, { limit: 20 }), "sigs");
    } catch {
      await sleep(2000);
      continue;
    }
    for (const s of sigs) {
      if (s.signature === afterSig || seen.has(s.signature)) continue;
      seen.add(s.signature);
      if (s.err) continue;
      let tx;
      try {
        tx = await rpc(() => c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }), "cb tx");
      } catch {
        continue;
      }
      if (!tx) continue;
      const logs = tx.meta?.logMessages ?? [];
      if (logs.some((l) => l.includes(`VrfSpikeConsume lane=${lane}`))) {
        return { sig: s.signature, tx };
      }
    }
    await sleep(2000);
  }
  return null;
}

function summarize(lane, seed, req, cb, payerBefore, payerAfter) {
  const reqTx = req.meta;
  const cbTx = cb?.tx;
  const logs = cbTx?.meta?.logMessages ?? [];
  const consumeLog = logs.find((l) => l.includes("VrfSpikeConsume")) ?? null;
  const reqLogs = reqTx?.meta?.logMessages ?? [];
  const reqLog = reqLogs.find((l) => l.includes("VrfSpikeRequest")) ?? null;
  const perProgram = [];
  for (const l of cbTx?.meta?.logMessages ?? []) {
    const m = l.match(/^Program (\S+) consumed (\d+) of (\d+) compute units/);
    if (m) perProgram.push({ program: m[1], cu: Number(m[2]), budget: Number(m[3]) });
  }
  return {
    lane,
    client_seed: seed,
    program_id: PROGRAM_ID.toBase58(),
    payer: payerBefore.pubkey.toBase58(),
    request_tx: req.sig,
    request_slot: reqTx?.slot ?? null,
    request_cu: reqTx?.meta?.computeUnitsConsumed ?? null,
    request_fee_lamports: reqTx?.meta?.fee ?? null,
    request_log: reqLog,
    fulfillment_tx: cb?.sig ?? null,
    fulfillment_slot: cbTx?.slot ?? null,
    fulfillment_cu_total: cbTx?.meta?.computeUnitsConsumed ?? null,
    fulfillment_fee_lamports: cbTx?.meta?.fee ?? null,
    fulfillment_latency_slots:
      cbTx && reqTx ? cbTx.slot - reqTx.slot : null,
    per_program_cu: perProgram,
    callback_log: consumeLog,
    queue_lamports_after: null,
    request_cost_lamports: payerBefore.lamports - payerAfter,
    request_cost_sol: (payerBefore.lamports - payerAfter) / LAMPORTS_PER_SOL,
  };
}

async function main() {
  const c = new Connection(RPC, "confirmed");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"))));

  console.log(`program:      ${PROGRAM_ID.toBase58()}`);
  console.log(`payer:        ${payer.publicKey.toBase58()}`);
  console.log(`queue:        ${QUEUE.toBase58()}`);
  console.log(`vrf program:  ${VRF_PROGRAM.toBase58()}`);
  console.log(`scoped idty:  ${scopedIdentity.toBase58()}`);
  console.log(`global idty:  ${GLOBAL_IDENTITY.toBase58()}`);

  const lanes = LANE === "both" ? ["scoped", "legacy"] : [LANE];
  const results = [];

  // One init for both lanes, only if needed.
  const existing = await rpc(() => c.getAccountInfo(stateScoped, { commitment: "confirmed" }), "state");
  if (!existing) {
    const { sig, meta } = await send(c, payer, initIx(payer.publicKey), "init");
    if (meta?.meta?.err) throw new Error(`init failed: ${JSON.stringify(meta.meta.err)}`);
    console.log(`init tx: ${sig}`);
  } else {
    console.log("init: already present");
  }

  let seed = 41;
  for (const lane of lanes) {
    const statePda = lane === "scoped" ? stateScoped : stateLegacy;
    const before = { pubkey: payer.publicKey, lamports: await rpc(() => c.getBalance(payer.publicKey), "bal") };

    console.log(`\n--- lane=${lane}: sending REAL RequestRandomness ---`);
    const t0 = Date.now();
    const ix = lane === "scoped" ? requestScopedIx(payer.publicKey, seed) : requestLegacyIx(payer.publicKey, seed);
    const req = await send(c, payer, ix, `request_${lane}`);
    console.log(`request tx:   ${req.sig}  (slot ${req.meta?.slot}, cu ${req.meta?.meta?.computeUnitsConsumed})`);
    for (const l of req.meta?.meta?.logMessages ?? []) console.log(`  | ${l}`);
    if (req.meta?.meta?.err) throw new Error(`request failed: ${JSON.stringify(req.meta.meta.err)}`);

    const after = await rpc(() => c.getBalance(payer.publicKey), "bal");
    console.log(`waiting for the real fulfillment (timeout ${TIMEOUT_MS}ms)...`);
    const cb = await waitForCallback(c, statePda, req.sig, lane);

    if (!cb) {
      console.error(`LANE ${lane}: NO FULFILLMENT within ${TIMEOUT_MS}ms — the request was NOT fulfilled.`);
      results.push({ lane, request_tx: req.sig, fulfilled: false });
      continue;
    }

    console.log(`\n--- lane=${lane}: REAL FULFILLMENT ---`);
    console.log(`fulfillment:  ${cb.sig}  (slot ${cb.tx.slot}, total cu ${cb.tx.meta.computeUnitsConsumed}, fee ${cb.tx.meta.fee} lamports)`);
    console.log(`latency:      ${((Date.now() - t0) / 1000).toFixed(1)}s wall / ${cb.tx.slot - req.meta.slot} slots`);
    for (const l of cb.tx.meta.logMessages) console.log(`  | ${l}`);

    const acc = await rpc(() => c.getAccountInfo(statePda, { commitment: "confirmed" }), "state after");
    const st = decodeState(acc.data);
    console.log(`state on-chain: ${JSON.stringify(st)}`);

    // Did the VRF program really sign as the right identity?
    let signerCheck = "not-inspected";
    for (const inner of cb.tx.meta.innerInstructions ?? []) {
      for (const i of inner.instructions) {
        const keys = cb.tx.transaction.message.accountKeys.map((k) =>
          typeof k === "string" ? k : typeof k.toBase58 === "function" ? k.toBase58() : k.pubkey.toBase58(),
        );
        const pid = typeof i.programId?.toBase58 === "function" ? i.programId.toBase58() : keys[i.programIdIndex];
        if (pid === PROGRAM_ID.toBase58() && (i.accounts?.length ?? 0) > 0) {
          const a0 = i.accounts[0];
          const addr = typeof a0 === "number" ? keys[a0] : a0?.pubkey?.toBase58?.() ?? "?";
          const isSigner = typeof a0 === "number" ? null : a0.isSigner;
          signerCheck = `callback account[0]=${addr} isSigner=${isSigner} expected=${lane === "scoped" ? scopedIdentity.toBase58() : GLOBAL_IDENTITY.toBase58()}`;
        }
      }
    }
    console.log(`identity check: ${signerCheck}`);

    const qAcc = await rpc(() => c.getAccountInfo(QUEUE, { commitment: "confirmed" }), "queue");
    const s = summarize(lane, seed, req, cb, before, after);
    s.queue_lamports_after = qAcc.lamports;
    s.state_after = st;
    s.identity_check = signerCheck;
    s.fulfilled = true;
    results.push(s);
    seed += 1;
  }

  console.log("\n###VRF-SPIKE-RESULT###");
  console.log(JSON.stringify({ program_id: PROGRAM_ID.toBase58(), results }, null, 2));
  console.log("###END###");

  if (!results.every((r) => r.fulfilled)) {
    process.exit(2);
  }
}

main().catch((e) => {
  console.error("SPIKE FAILED:", e?.message ?? e);
  process.exit(1);
});
