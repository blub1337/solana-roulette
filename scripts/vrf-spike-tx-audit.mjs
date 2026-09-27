// Audit: from our two on-chain request txs, recover the EXACT bytes the VRF
// program used (slot, slothash) and derive the queue id it must have stored,
// then check whether those bytes still exist in the queue account.
import { Connection, PublicKey } from "@solana/web3.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const QUEUE = new PublicKey("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");
const SLOT_HASHES = new PublicKey("SysvarS1otHashes111111111111111111111111111");
const REQUEST_SIGS = [
  "2RBgqYYUMdkvxXR465qNuuJVPpmxHsNDmk4QDstrhwzrktU7oixWf3wjYPPr15o4FScfYK1k9bSaCCLGN7CFrNxt",
  "5AMQG4uJsoKh9NfL5m2RSzp2QU89TH3h1zTLHc7exruprkqh4NnU3Np6B9zAgvozayZZnYmJsbasC1sG7L89KKYE",
];
const PROGRAM_ID = "HRdbK1k8XXQCcJDfeT8ihL4f7eLkiBKkEWmGJ95GaiRC";
const { createHash } = await import("node:crypto");

const c = new Connection(RPC, "confirmed");
const q = await c.getAccountInfo(QUEUE);

for (const sig of REQUEST_SIGS) {
  const tx = await c.getTransaction(sig, { maxSupportedTransactionVersion: 0 }).catch(() => null);
  if (!tx) {
    console.log(`${sig.slice(0, 16)}…: tx unavailable`);
    continue;
  }
  const slot = tx.slot;
  console.log(`\n=== request ${sig.slice(0, 16)}… slot=${slot}`);
  // The slothash the program mixed in = slot_hashes entry for `slot`. RPC cannot
  // expose it, but we can approximate what we CAN prove: the ix data.
  const inner = tx.meta.innerInstructions ?? [];
  for (const i of inner) {
    for (const ix of i.instructions) {
      const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey?.toBase58?.() ?? String(k));
      const pid =
        typeof ix.programId?.toBase58 === "function" ? ix.programId.toBase58() : keys[ix.programIdIndex];
      if (pid !== "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz") continue;
      const hex = Buffer.from(ix.data).toString("hex");
      console.log(`  VRF ix data (${hex.length / 2} bytes): ${hex.slice(0, 64)}…`);
      // Parse: disc u8 | caller_seed [32] | callback_program_id [32] | disc vec | metas vec | args vec
      const data = Buffer.from(ix.data);
      const callerSeed = data.subarray(1, 33).toString("hex");
      const cbProgram = new PublicKey(data.subarray(33, 65)).toBase58();
      console.log(`  caller_seed: ${callerSeed}`);
      console.log(`  callback_program_id: ${cbProgram} (ours: ${cbProgram === PROGRAM_ID})`);
      console.log(`  ix discriminator byte: ${data[0]} (3=high-priority, 8=regular, 10/11=scoped rewrites by 0.17.3 macro)`);
    }
  }
}
console.log("\nqueue state now: item_count =", q.data.readUInt32LE(8));
const me = new PublicKey("7iNjk7DGkugXn2cmEQz9JWZsZgHM7RUh4N7WB9SRPxp8").toBuffer();
console.log("our identity PDA bytes still in the queue:", q.data.indexOf(me) !== -1);
