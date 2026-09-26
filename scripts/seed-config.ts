/**
 * Anchor-deployable script: initializes GlobalConfig on the target cluster.
 * Run with `anchor run seed-config` (requires OPERATOR_KEYPAIR + treasury).
 *
 * Instruction surface (must match programs/roulette/src/lib.rs):
 *   initialize_config(ctx, operator: Pubkey, fee_bps: u16, max_round_size: u64,
 *                     min_deposit: u64, max_deposit: u64)
 *   Accounts: [config (w), operator (s, w), treasury (w), system_program]
 * The treasury is an ACCOUNT (frozen on config), not an instruction arg.
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
import { getGlobalConfigPda } from "../packages/verification/src/index.js";
import { anchorDiscriminator } from "../packages/sdk/src/index.js";

function leU16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
}
function leU64(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

async function main() {
  const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
  if (!process.env.OPERATOR_KEYPAIR) throw new Error("OPERATOR_KEYPAIR required");
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(process.env.OPERATOR_KEYPAIR)));
  const programId = new PublicKey(process.env.ROULETTE_PROGRAM_ID!);
  const treasury = new PublicKey(process.env.TREASURY_PUBKEY ?? payer.publicKey.toBase58());
  const [configPda] = getGlobalConfigPda(programId);

  const operatorArg = payer.publicKey.toBuffer(); // first INSTRUCTION ARG in lib.rs
  const feeBps = Number(process.env.FEE_BPS ?? 750);
  const maxRoundSize = BigInt(process.env.MAX_ROUND_SIZE_LAMPORTS ?? 10_000_000_000);
  const minDeposit = BigInt(process.env.MIN_DEPOSIT_LAMPORTS ?? 10_000_000);
  const maxDeposit = BigInt(process.env.MAX_DEPOSIT_LAMPORTS ?? 1_000_000_000);

  const data = Buffer.concat([
    anchorDiscriminator("initialize_config"),
    operatorArg,
    leU16(feeBps),
    leU64(maxRoundSize),
    leU64(minDeposit),
    leU64(maxDeposit),
  ]);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true }, // writable: pay_winners CPI pays it
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  // Idempotent: if the config PDA already exists, the program would reject a
  // second initialize (ConfigAlreadyInitialized) — check before spending fees.
  const existing = await connection.getAccountInfo(configPda);
  if (existing) {
    console.log("GlobalConfig already initialized at", configPda.toBase58(), "— nothing to do");
    return;
  }

  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer]);
  console.log("initialize_config confirmed:", sig);
  console.log("config PDA:", configPda.toBase58());
  console.log("operator:", payer.publicKey.toBase58());
  console.log("treasury:", treasury.toBase58());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
