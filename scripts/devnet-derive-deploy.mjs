// Derives the spike deploy keypair locally exactly as the CI workflow does, so
// the live program can be inspected from this sandbox. Never prints a secret.
import { createHash } from "node:crypto";
import fs from "node:fs";
import nacl from "tweetnacl";
import { PublicKey, Connection } from "@solana/web3.js";

const PREFIX = "roulette-vrf-spike-v1:";
const seed = createHash("sha256")
  .update(PREFIX + process.env.OPERATOR_KEYPAIR_B64)
  .digest();
const kp = nacl.sign.keyPair.fromSeed(seed);
const programId = new PublicKey(kp.publicKey);

const c = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const info = await c.getAccountInfo(programId, { commitment: "confirmed" });
console.log(`spike program id : ${programId.toBase58()}`);
if (!info) {
  console.log("status           : NOT DEPLOYED");
} else {
  console.log(`status           : LIVE  owner=${info.owner.toBase58()} lamports=${info.lamports} datalen=${info.data.length}`);
}
const [identity] = PublicKey.findProgramAddressSync([Buffer.from("identity")], programId);
const [state] = PublicKey.findProgramAddressSync([Buffer.from("state")], programId);
console.log(`program identity : ${identity.toBase58()}`);
console.log(`state PDA        : ${state.toBase58()}`);
const si = await c.getAccountInfo(state, { commitment: "confirmed" });
if (si) {
  const st = {
    request_count: si.data.readUInt32LE(8),
    fulfill_count: si.data.readUInt32LE(12),
    client_seed: si.data.readUInt8(16),
    last_lane: si.data.readUInt8(17),
    roll: si.data.readUInt8(18),
    fulfilled: si.data.readUInt8(19),
    randomness: si.data.subarray(20, 52).toString("hex"),
    bump: si.data.readUInt8(52),
  };
  console.log(`state            : ${JSON.stringify(st)}`);
} else {
  console.log("state            : not initialized");
}
const payerSecret = Uint8Array.from(JSON.parse(fs.readFileSync("operator-devnet.key.json", "utf8")));
const payer = new PublicKey(payerSecret.subarray(32));
const bal = await c.getBalance(payer, { commitment: "confirmed" });
console.log(`payer balance    : ${(bal / 1e9).toFixed(4)} SOL (${payer.toBase58()})`);
