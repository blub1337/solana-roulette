/**
 * Operator-only treasury update: calls the upgraded program's `set_treasury`
 * instruction and verifies the on-chain GlobalConfig before/after.
 *
 *   node scripts/set-treasury-devnet.mjs <treasury_pubkey>
 *   node scripts/set-treasury-devnet.mjs <treasury_pubkey> --keypair fee-wallet-devnet.key.json
 *
 * The program enforces signer == config.operator (and treasury != default), so
 * this must run with the operator keypair (the upgrade authority that owns the
 * GlobalConfig operator field) — operator-devnet.key.json in this workspace.
 *
 * It only affects FUTURE `pay_winners` calls: rounds already settled keep the
 * treasury they were paid with, and fees already received are never moved.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.ROULETTE_PROGRAM_ID || "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos"
);
const OPERATOR_KEYFILE = process.env.OPERATOR_KEYFILE || "operator-devnet.key.json";

const [treasuryArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!treasuryArg) {
  console.error("usage: node scripts/set-treasury-devnet.mjs <treasury_pubkey>");
  process.exit(1);
}
let NEW_TREASURY;
try {
  NEW_TREASURY = new PublicKey(treasuryArg);
} catch {
  console.error("treasury must be a valid base58 pubkey");
  process.exit(1);
}
if (NEW_TREASURY.equals(PublicKey.default)) {
  console.error("treasury must not be the default (zero) address");
  process.exit(1);
}

// Anchor discriminator = sha256("global:" + snake_case_method)[0..8].
const disc = (method) =>
  createHash("sha256").update(`global:${method}`).digest().subarray(0, 8);

// GlobalConfig layout (Anchor: 8 disc + fields, little-endian):
// operator(32) treasury(32) fee_bps(2) max_round_size(8) min_deposit(8)
// max_deposit(8) reveal_offset(8) round_counter(8) tier_caps(24) bump(1)
function decodeConfig(data) {
  return {
    operator: new PublicKey(data.subarray(8, 40)).toBase58(),
    treasury: new PublicKey(data.subarray(40, 72)).toBase58(),
    feeBps: data.readUInt16LE(72),
    roundCounter: data.readBigUInt64LE(106),
  };
}

const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);

const connection = new Connection(RPC, "confirmed");
const operator = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(OPERATOR_KEYFILE, "utf8")))
);

const before = decodeConfig((await connection.getAccountInfo(configPda, "confirmed")).data);
console.log(`program      ${PROGRAM_ID.toBase58()}`);
console.log(`config       ${configPda.toBase58()}`);
console.log(`operator     ${before.operator}`);
console.log(`treasury     ${before.treasury} -> ${NEW_TREASURY.toBase58()}`);
console.log(`roundCounter ${before.roundCounter}`);

if (before.operator !== operator.publicKey.toBase58()) {
  console.error("keypair is NOT the config operator — refusing");
  process.exit(1);
}
if (before.treasury === NEW_TREASURY.toBase58()) {
  console.log("\nalready at that treasury — nothing to do");
  process.exit(0);
}

// set_treasury(treasury: Pubkey): accounts = [config(w), operator(s,w), system_program]
const data = Buffer.concat([disc("set_treasury"), NEW_TREASURY.toBuffer()]);
const ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: configPda, isSigner: false, isWritable: true },
    { pubkey: operator.publicKey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data,
});

const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
const tx = new Transaction({ feePayer: operator.publicKey, blockhash, lastValidBlockHeight }).add(ix);
const sig = await sendAndConfirmTransaction(connection, tx, [operator], { commitment: "confirmed" });
console.log(`\nset_treasury tx ${sig}`);
console.log(`explorer        https://explorer.solana.com/tx/${sig}?cluster=devnet`);

const after = decodeConfig((await connection.getAccountInfo(configPda, "confirmed")).data);
console.log(`\ntreasury now    ${after.treasury}`);
console.log(`fee_bps now     ${after.feeBps}`);
console.log(`roundCounter    ${after.roundCounter}`);

const ok =
  after.treasury === NEW_TREASURY.toBase58() &&
  after.feeBps === before.feeBps &&
  after.roundCounter === before.roundCounter;
console.log(ok ? "\nSET_TREASURY VERIFIED ON CHAIN" : "\nUNEXPECTED CONFIG STATE");
process.exit(ok ? 0 : 1);
