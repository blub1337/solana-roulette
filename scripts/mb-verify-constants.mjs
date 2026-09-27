// Phase 1 re-verification of MagicBlock SolanaVrf on-chain constants.
// Read-only: getAccountInfo only. Never prints a secret.
import { Connection, PublicKey } from "@solana/web3.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const NAMES = {
  Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz: "VRF_PROGRAM (candidate)",
  Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh: "DEFAULT_QUEUE (candidate)",
  "5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc": "DEFAULT_EPHEMERAL_QUEUE (candidate)",
  "9irBy75QS2BN81FUgXuHcjqceJJRuc9oDkAe8TKVvvAw": "VRF_PROGRAM_IDENTITY (candidate)",
  F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos: "roulette program (ours)",
};

const IDENTITY_SEED = Buffer.from("identity");
const VRF_PROGRAM = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");

function findProgramAddress(seeds, programId) {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

const c = new Connection(RPC, "confirmed");

console.log(`RPC: ${new URL(RPC).host}`);
console.log(`slot: ${await c.getSlot()}`);
console.log("");

for (const [addr, name] of Object.entries(NAMES)) {
  const pk = new PublicKey(addr);
  const info = await c.getAccountInfo(pk, { commitment: "confirmed" });
  if (!info) {
    console.log(`MISSING  ${name}\n         ${addr}`);
    continue;
  }
  const executable = info.executable;
  const lamports = info.lamports;
  const owner = info.owner.toBase58();
  const dataLen = info.data.length;
  let extra = "";
  if (dataLen >= 8) {
    const first = Buffer.from(info.data.subarray(0, 8)).toString("hex");
    extra = ` first8=${first}`;
  }
  if (dataLen >= 45) {
    const programDataAddr = new PublicKey(info.data.subarray(4, 36));
    const pdi = await c.getAccountInfo(programDataAddr, { commitment: "confirmed" });
    extra += ` programdata=${programDataAddr.toBase58()} present=${Boolean(pdi)}`;
  }
  console.log(
    `FOUND    ${name}\n         ${addr}\n         owner=${owner} executable=${executable} lamports=${lamports} datalen=${dataLen}${extra}`,
  );
}

// PDA candidates for the identity account under the VRF program.
console.log("");
const PDA_TRY = [
  ["identity", Buffer.from([IDENTITY_SEED])],
  ["account:identity", Buffer.from("account:identity")],
  ["magicblock", Buffer.from("magicblock")],
  ["vrf", Buffer.from("vrf")],
  ["solana-vrf", Buffer.from("solana-vrf")],
];
for (const [label, seed] of PDA_TRY) {
  let pda;
  try {
    pda = findProgramAddress([seed], VRF_PROGRAM);
  } catch {
    continue;
  }
  const info = await c.getAccountInfo(pda, { commitment: "confirmed" });
  console.log(
    `PDA[${label}] ${pda.toBase58()} -> ${info ? `FOUND owner=${info.owner.toBase58()} lamports=${info.lamports}` : "not present (may be created at runtime)"}`,
  );
}
