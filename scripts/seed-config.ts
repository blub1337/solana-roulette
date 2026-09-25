/**
 * Anchor-deployable script: initializes GlobalConfig on the target cluster.
 * Run with `anchor run seed-config` (requires OPERATOR_KEYPAIR + treasury).
 */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getGlobalConfigPda } from "../packages/verification/src/index.js";
import { anchorDiscriminator } from "../packages/sdk/src/index.js";

async function main() {
  const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
  if (!process.env.OPERATOR_KEYPAIR) throw new Error("OPERATOR_KEYPAIR required");
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(process.env.OPERATOR_KEYPAIR)));
  const programId = new PublicKey(process.env.ROULETTE_PROGRAM_ID!);
  const treasury = new PublicKey(process.env.TREASURY_PUBKEY ?? payer.publicKey.toBase58());
  const [configPda] = getGlobalConfigPda(programId);

  const feeBps = Number(process.env.FEE_BPS ?? 750);
  const maxRoundSize = BigInt(process.env.MAX_ROUND_SIZE_LAMPORTS ?? 10_000_000_000);
  const minDeposit = BigInt(process.env.MIN_DEPOSIT_LAMPORTS ?? 10_000_000);
  const maxDeposit = BigInt(process.env.MAX_DEPOSIT_LAMPORTS ?? 1_000_000_000);

  const data = Buffer.concat([
    anchorDiscriminator("initialize_config"),
    (() => { const b = Buffer.alloc(2); new DataView(b.buffer).setUint16(0, feeBps, true); return b; })(),
    (() => { const b = Buffer.alloc(8); new DataView(b.buffer).setBigUint64(0, maxRoundSize, true); return b; })(),
    (() => { const b = Buffer.alloc(8); new DataView(b.buffer).setBigUint64(0, minDeposit, true); return b; })(),
    (() => { const b = Buffer.alloc(8); new DataView(b.buffer).setBigUint64(0, maxDeposit, true); return b; })(),
  ]);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer]);
  console.log("initialize_config confirmed:", sig);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
