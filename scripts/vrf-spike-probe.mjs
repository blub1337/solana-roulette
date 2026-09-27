// Minimal probe: find exactly which step throws "Invalid arguments".
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

const c = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("operator-devnet.key.json", "utf8"))),
);
const PROGRAM_ID = new PublicKey(process.argv[2] ?? "HRdbK1k8XXQCcJDfeT8ihL4f7eLkiBKkEWmGJ95GaiRC");
const [state] = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);
const disc = (m) => createHash("sha256").update(`global:${m}`).digest().subarray(0, 8);

console.log("1. getLatestBlockhash...");
const bh = await c.getLatestBlockhash("confirmed");
console.log("   ok", bh.blockhash.slice(0, 12));

console.log("2. getAccountInfo(state)...");
console.log("   ok", (await c.getAccountInfo(state)) === null ? "null (not init)" : "exists");

console.log("2b. getAccountInfo with config object...");
try {
  const i2 = await c.getAccountInfo(state, { commitment: "confirmed" });
  console.log("   ok", i2 === null ? "null" : "exists");
} catch (e) {
  console.log("   ERROR:", e.message);
}

console.log("2c. getBalance...");
try {
  console.log("   ok", await c.getBalance(payer.publicKey));
} catch (e) {
  console.log("   ERROR:", e.message);
}

console.log("2d. getSignaturesForAddress...");
try {
  console.log("   ok", (await c.getSignaturesForAddress(state, { limit: 5 })).length, "sigs");
} catch (e) {
  console.log("   ERROR:", e.message);
}

console.log("2e. getSignatureStatus...");
try {
  console.log("   ok", JSON.stringify(await c.getSignatureStatus("5iu9qTVgFG4M2CFEB4XSK4G3EGKcBZxF3p26FE586CgFJBBUVz4tXULiDP1eJn9dmdAFpLHUzUbwSgzrWbnHAcxX", { searchTransactionHistory: true })));
} catch (e) {
  console.log("   ERROR:", e.message);
}

console.log("2f. getTransaction...");
try {
  const t = await c.getTransaction("5iu9qTVgFG4M2CFEB4XSK4G3EGKcBZxF3p26FE586CgFJBBUVz4tXULiDP1eJn9dmdAFpLHUzUbwSgzrWbnHAcxX", { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  console.log("   ok", t ? "fetched" : "null");
} catch (e) {
  console.log("   ERROR:", e.message);
}

console.log("3. sendTransaction(request_randomness)...");
const VRF_PROGRAM = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const QUEUE = new PublicKey("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");
const SLOT_HASHES = new PublicKey("SysvarS1otHashes111111111111111111111111111");
const [programIdentity] = PublicKey.findProgramAddressSync([Buffer.from("identity")], PROGRAM_ID);
const requestIx = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: programIdentity, isSigner: false, isWritable: false },
    { pubkey: QUEUE, isSigner: false, isWritable: true },
    { pubkey: state, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SLOT_HASHES, isSigner: false, isWritable: false },
    { pubkey: VRF_PROGRAM, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([disc("request_randomness"), Buffer.from([41, 0])]),
});
const bh2 = await c.getLatestBlockhash("confirmed");
const tx2 = new Transaction({ feePayer: payer.publicKey, blockhash: bh2.blockhash, lastValidBlockHeight: bh2.lastValidBlockHeight });
tx2.add(requestIx);
try {
  const sig2 = await c.sendTransaction(tx2, [payer], { skipPreflight: false });
  console.log("   sent:", sig2);
  await new Promise((r) => setTimeout(r, 6000));
  const t2 = await c.getTransaction(sig2, { maxSupportedTransactionVersion: 0 });
  for (const l of t2?.meta?.logMessages ?? []) console.log("   |", l);
  if (t2?.meta?.err) console.log("   TX ERR:", JSON.stringify(t2.meta.err));
} catch (e) {
  console.log("   SEND ERROR:", e.message);
  if (e.logs) e.logs.forEach((l) => console.log("   |", l));
}
