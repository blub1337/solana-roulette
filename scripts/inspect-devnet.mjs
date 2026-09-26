/**
 * Read-only devnet inspection — no signatures, no mutations.
 *
 *   node scripts/inspect-devnet.mjs
 *
 * Reports:
 *   - operator wallet address + devnet SOL balance (from operator-devnet.key.json)
 *   - the deployed program account (executable? loader owner?)
 *   - its ProgramData account: deploy slot, last-modified slot, ELF sha256, size
 *   - whether the GlobalConfig PDA exists yet
 *   - the treasury wallet balance
 *
 * The operator SECRET is never printed — only its public address.
 */
import {
  Connection,
  PublicKey,
  Keypair,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.ROULETTE_PROGRAM_ID || "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos"
);
const TREASURY = new PublicKey(
  process.env.TREASURY_PUBKEY || "6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR"
);
const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

const connection = new Connection(RPC, "confirmed");
const slot = await connection.getSlot("confirmed");
console.log(`rpc          ${RPC}`);
console.log(`cluster slot ${slot}\n`);

// ---------- operator wallet ----------
const operator = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync("operator-devnet.key.json", "utf8")))
);
const opBal = await connection.getBalance(operator.publicKey, "confirmed");
console.log(`operator      ${operator.publicKey.toBase58()}`);
console.log(`  balance     ${opBal} lamports (${(opBal / 1e9).toFixed(4)} SOL)`);

// ---------- treasury ----------
const trBal = await connection.getBalance(TREASURY, "confirmed");
console.log(`treasury      ${TREASURY.toBase58()}`);
console.log(`  balance     ${trBal} lamports (${(trBal / 1e9).toFixed(4)} SOL)`);

// ---------- program account ----------
const prog = await connection.getAccountInfo(PROGRAM_ID, "confirmed");
if (!prog) {
  console.log(`\nprogram      ${PROGRAM_ID.toBase58()}`);
  console.log(`  NOT DEPLOYED — no account at this address`);
  process.exit(1);
}
console.log(`\nprogram      ${PROGRAM_ID.toBase58()}`);
console.log(`  executable  ${prog.executable}`);
console.log(`  owner       ${prog.owner.toBase58()}`);
console.log(`  lamports    ${prog.lamports}`);
console.log(`  data space  ${prog.data.length} bytes (4-byte enum + 32-byte programdata)`);

if (!prog.executable) {
  console.log("  ✖ NOT EXECUTABLE — the program is not runnable");
  process.exit(1);
}
if (!prog.owner.equals(BPF_LOADER_UPGRADEABLE)) {
  console.log("  ! not owned by BPFLoaderUpgradeable — not a modern Anchor deploy");
}

// ---------- programdata account ----------
const programdata = new PublicKey(prog.data.subarray(4));
const pd = await connection.getAccountInfo(programdata, "confirmed");
if (!pd) {
  console.log(`  ✖ ProgramData ${programdata.toBase58()} missing`);
  process.exit(1);
}
// ProgramData layout: 4-byte enum (2) | 8-byte slot | 1-byte option | 32-byte authority
const view = new DataView(pd.data.buffer, pd.data.byteOffset, pd.data.byteLength);
const deploySlot = view.getBigUint64(4, true);
const hasAuthority = pd.data[12] === 1;
const authority = hasAuthority ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : "(none — immutable)";
const elf = pd.data.subarray(45);
const elfSha = createHash("sha256").update(elf).digest("hex");

console.log(`\nprogramdata  ${programdata.toBase58()}`);
console.log(`  deploy slot ${deploySlot}`);
console.log(`  authority   ${authority}`);
console.log(`  elf size    ${elf.length} bytes`);
console.log(`  elf sha256  ${elfSha}`);

// Which anchor symbols survived into the deployed ELF — lets us tell which
// revision of the source is actually on chain.
const marks = [
  "DuplicateDeposit",
  "InvalidParticipant",
  "InvalidRoundStatus",
  "initialize_config",
  "create_round",
  "lock_round",
  "settle_round",
  "pay_winners",
];
console.log("\n  instruction/error markers in deployed ELF:");
for (const m of marks) {
  const hit = elf.includes(Buffer.from(m, "utf8"));
  console.log(`    ${hit ? "yes" : "NO "}  ${m}`);
}

// ---------- config PDA ----------
const [configPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("config")],
  PROGRAM_ID
);
const cfg = await connection.getAccountInfo(configPda, "confirmed");
console.log(`\nGlobalConfig ${configPda.toBase58()}`);
if (cfg) {
  console.log(`  EXISTS     owner=${cfg.owner.toBase64?.() ?? cfg.owner.toBase58()}`);
  console.log(`  lamports   ${cfg.lamports}`);
  console.log(`  space      ${cfg.data.length} bytes`);
  console.log(`  data(b64)  ${cfg.data.toString("base64").slice(0, 120)}`);
} else {
  console.log(`  NOT INITIALIZED — run scripts/seed-config.ts`);
}
console.log("");
