/**
 * Read the EXACT SlotHashes sysvar content the program consumed, by
 * simulating settle_round and asking the RPC to return the sysvar account
 * post-execution. Then compare the program's chosen reveal value against
 * getBlock(reveal_slot).blockhash.
 *
 *   npx tsx scripts/devnet-slot-hashes.ts <roundId>
 */
import {
  Connection,
  PublicKey,
  Keypair,
  TransactionMessage,
  SYSVAR_SLOT_HASHES_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  getRoundPda,
  getEscrowPda,
  getParticipantPda,
  getGlobalConfigPda,
  fetchParticipantsForRound,
  deriveRandomness,
} from "../packages/verification/src/index.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.ROULETTE_PROGRAM_ID || "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos"
);
const TREASURY = new PublicKey("6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR");
const connection = new Connection(RPC, "confirmed");
const disc = (n: string) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);

async function main() {
  const roundId = BigInt(process.argv[2] ?? 6);
  const op = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("operator-devnet.key.json", "utf8"))));
  const [rk] = getRoundPda(PROGRAM_ID, roundId);
  const [ek] = getEscrowPda(PROGRAM_ID, rk);
  const [ck] = getGlobalConfigPda(PROGRAM_ID);
  const parts = (await fetchParticipantsForRound(connection, PROGRAM_ID, rk)).slice().sort((a, b) => a.index - b.index);
  const partPdas = parts.map((p) => getParticipantPda(PROGRAM_ID, rk, p.wallet)[0]);

  const keys = [
    { pubkey: ck, isSigner: false, isWritable: false },
    { pubkey: rk, isSigner: false, isWritable: true },
    { pubkey: ek, isSigner: false, isWritable: true },
    { pubkey: TREASURY, isSigner: false, isWritable: false },
    { pubkey: op.publicKey, isSigner: true, isWritable: true },
    { pubkey: SYSVAR_SLOT_HASHES_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ...partPdas.map((p) => ({ pubkey: p, isSigner: false, isWritable: false })),
  ];

  const message = new TransactionMessage({
    payerKey: op.publicKey,
    recentBlockhash: (await connection.getLatestBlockhash("confirmed")).blockhash,
    instructions: [{
      programId: PROGRAM_ID,
      keys,
      data: Buffer.from(disc("settle_round")),
    }],
  }).compileToLegacyMessage();

  const res: any = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "simulateTransaction",
      params: [
        Buffer.from(message.serialize()).toString("base64"),
        {
          encoding: "base64",
          sigVerify: false,
          replaceRecentBlockhash: true,
          accounts: { encoding: "base64", addresses: [SYSVAR_SLOT_HASHES_PUBKEY.toBase58()] },
        },
      ],
    }),
  }).then((r) => r.json());

  const v = res?.result?.value ?? {};
  console.log(`settle_round simulation err: ${v.err ? JSON.stringify(v.err) : "none"}`);
  const acct = v.accounts?.[0]?.account;
  if (!acct) {
    console.log("sysvar account not returned; logs:");
    (v.logs ?? []).forEach((l: string) => console.log("  " + l));
    return;
  }
  const data = Buffer.from(acct.data[0], "base64");
  const count = Number(data.readBigUInt64LE(0));
  console.log(`\nSlotHashes sysvar as the program saw it: ${data.length} bytes, ${count} entries (newest first)`);

  const rAcc: any = await connection.getAccountInfo(rk, "confirmed");
  const d = rAcc.data;
  const revealSlot = d.readBigUInt64LE(85);
  const onChainRandomness = Buffer.from(d.subarray(95, 127)).toString("hex");
  console.log(`round.reveal_slot = ${revealSlot}`);
  console.log(`round.randomness  = ${onChainRandomness}\n`);

  let off = 8;
  for (let i = 0; i < count && off + 40 <= data.length; i++) {
    const slot = data.readBigUInt64LE(off);
    const hash = Buffer.from(data.subarray(off + 8, off + 40));
    if (slot >= revealSlot - 2n && slot <= revealSlot + 2n) {
      const derived = Buffer.from(deriveRandomness(hash, roundId)).toString("hex");
      const match = derived === onChainRandomness;
      console.log(`  [${i}] slot ${slot}  hash ${hash.toString("hex")}`);
      console.log(`        derived randomness ${derived}  ${match ? "<== MATCHES the program" : ""}`);
      if (match) {
        const blk = await connection.getBlock(Number(slot), { maxSupportedTransactionVersion: 1 });
        console.log(`        getBlock(${slot}).blockhash = ${blk?.blockhash}`);
        console.log(`        identical to the sysvar entry: ${blk ? new PublicKey(blk.blockhash).toBytes().equals(hash) : "n/a"}`);
      }
    }
    off += 40;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
