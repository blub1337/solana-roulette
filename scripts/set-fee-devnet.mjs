/**
 * Operator-only fee update: calls the upgraded program's `set_fee` instruction
 * and verifies the on-chain GlobalConfig before/after.
 *
 *   node scripts/set-fee-devnet.mjs <fee_bps>
 *
 * The program enforces signer == config.operator, so this must run with the
 * operator keypair (upgrade authority) that owns the GlobalConfig operator
 * field — operator-devnet.key.json in this workspace.
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

const FEE_BPS = Number(process.argv[2] ?? 200);
if (!Number.isInteger(FEE_BPS) || FEE_BPS < 0 || FEE_BPS > 3000) {
  console.error("fee_bps must be an integer in [0, 3000] (program cap)");
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
    // 8 disc + 32 op + 32 tr + 2 fee + 8 mrs + 8 min + 8 max + 8 reveal = 106
    roundCounter: data.readBigUInt64LE(106),
  };
}

const [configPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("config")],
  PROGRAM_ID
);

const connection = new Connection(RPC, "confirmed");
const operator = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync("operator-devnet.key.json", "utf8")))
);

const before = decodeConfig((await connection.getAccountInfo(configPda, "confirmed")).data);
console.log(`program      ${PROGRAM_ID.toBase58()}`);
console.log(`config       ${configPda.toBase58()}`);
console.log(`operator     ${before.operator}`);
console.log(`fee_bps      ${before.feeBps} -> ${FEE_BPS}`);
console.log(`roundCounter ${before.roundCounter}`);

if (before.operator !== operator.publicKey.toBase58()) {
  console.error("keypair is NOT the config operator — refusing");
  process.exit(1);
}

// set_fee(fee_bps: u16): accounts = [config(w), operator(s,w), system_program]
const data = Buffer.concat([disc("set_fee"), Buffer.from(new Uint16Array([FEE_BPS]).buffer).subarray(0, 2)]);
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
console.log(`\nset_fee tx   ${sig}`);
console.log(`explorer     https://explorer.solana.com/tx/${sig}?cluster=devnet`);

const after = decodeConfig((await connection.getAccountInfo(configPda, "confirmed")).data);
console.log(`\nfee_bps now  ${after.feeBps}`);
console.log(`roundCounter ${after.roundCounter}`);

const ok = after.feeBps === FEE_BPS && after.roundCounter === before.roundCounter;
console.log(ok ? "\nSET_FEE VERIFIED ON CHAIN" : "\nUNEXPECTED CONFIG STATE");
process.exit(ok ? 0 : 1);
