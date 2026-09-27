// Derives the THROWAWAY spike deploy keypair from the operator secret and pins
// it into the spike's declare_id!.
//
// The prefix deliberately differs from the roulette deploy prefix
// ("roulette-deploy-v1:"), so the spike can never land on the money-moving
// program id F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos. It also refuses to
// run if the derived id ever collides with it.
//
// The secret is only ever read from the environment and never printed: this
// script prints public keys, file paths and the sha256 of nothing secret.
//
//   OPERATOR_KEYPAIR_B64=... node scripts/vrf-spike-derive-deploy.mjs
import { createHash } from "node:crypto";
import fs from "node:fs";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";

const PREFIX = "roulette-vrf-spike-v1:";
const ROULETTE_PROGRAM_ID = "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos";
const KEYPAIR_OUT = "target/deploy/vrf-spike-keypair.json";
const LIB = "programs/vrf-spike/src/lib.rs";

const b64 = process.env.OPERATOR_KEYPAIR_B64;
if (!b64) {
  console.error("OPERATOR_KEYPAIR_B64 is not set; cannot derive the spike keypair.");
  process.exit(1);
}

const seed = createHash("sha256").update(PREFIX + b64).digest();
const kp = nacl.sign.keyPair.fromSeed(seed);
const programId = new PublicKey(kp.publicKey).toBase58();

if (programId === ROULETTE_PROGRAM_ID) {
  console.error("REFUSING: derived spike id equals the roulette program id.");
  process.exit(1);
}

fs.mkdirSync("target/deploy", { recursive: true });
fs.writeFileSync(KEYPAIR_OUT, JSON.stringify([...kp.secretKey]));
fs.chmodSync(KEYPAIR_OUT, 0o600);

let lib = fs.readFileSync(LIB, "utf8");
const next = lib.replace(
  /declare_id!\("[^"]*"\)/,
  `declare_id!("${programId}")`,
);
if (next !== lib) {
  fs.writeFileSync(LIB, next);
  console.log(`declare_id! pinned to ${programId}`);
} else {
  console.log(`declare_id! already ${programId}`);
}

console.log(`SPIKE_PROGRAM_ID=${programId}`);
console.log(`keypair written to ${KEYPAIR_OUT} (mode 600, not printed)`);
console.log(`scoped identity PDA: ${PublicKey.findProgramAddressSync(
  [Buffer.from("identity"), new PublicKey(programId).toBuffer()],
  new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz"),
)[0].toBase58()}`);
