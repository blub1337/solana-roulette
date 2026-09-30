/**
 * Why does the off-chain recompute disagree with the randomness the program
 * froze? Brute-force the candidate blockhashes around reveal_slot and find
 * which one reproduces the on-chain randomness.
 *
 *   npx tsx scripts/devnet-randomness-diag.ts <roundId>
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { getRoundPda, deriveRandomness } from "../packages/verification/src/index.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.ROULETTE_PROGRAM_ID || "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos"
);
const connection = new Connection(RPC, "confirmed");

// Minimal Round decode (225-byte layout).
function decodeRound(buf: Buffer) {
  const o = { id: 0n, status: buf[16], lockSlot: 0n, revealSlot: 0n, feeBps: 0n, randomness: "" };
  let i = 8;
  o.id = buf.readBigUInt64LE(i); i += 8;
  i += 1; // status
  i += 32; // escrow
  i += 8; // pot
  i += 16; // weight
  i += 4; // count
  o.lockSlot = buf.readBigUInt64LE(i); i += 8;
  o.revealSlot = buf.readBigUInt64LE(i); i += 8;
  o.feeBps = BigInt(buf.readUInt16LE(i)); i += 2;
  o.randomness = Buffer.from(buf.subarray(i, i + 32)).toString("hex");
  return o;
}

async function main() {
  const roundId = BigInt(process.argv[2] ?? 6);
  const [rk] = getRoundPda(PROGRAM_ID, roundId);
  const r = decodeRound((await connection.getAccountInfo(rk, "confirmed"))!.data);
  console.log(`round ${roundId}`);
  console.log(`  lock_slot    ${r.lockSlot}`);
  console.log(`  reveal_slot  ${r.revealSlot}`);
  console.log(`  randomness   ${r.randomness}  (frozen on chain)`);
  console.log();

  const target = r.randomness;
  const candidates: { label: string; hash: Uint8Array }[] = [];
  for (let d = -3; d <= 3; d++) {
    const slot = Number(r.revealSlot) + d;
    try {
      const b: any = await connection.getBlock(slot, { maxSupportedTransactionVersion: 1 });
      if (!b) continue;
      candidates.push({ label: `getBlock(${slot}).blockhash`, hash: new Uint8Array(new PublicKey(b.blockhash).toBytes()) });
      if (b.previousBlockhash) {
        candidates.push({ label: `getBlock(${slot}).previousBlockhash`, hash: new Uint8Array(new PublicKey(b.previousBlockhash).toBytes()) });
      }
    } catch { /* slot not available */ }
  }

  console.log(`  testing ${candidates.length} candidate entropy values against the on-chain randomness:\n`);
  let match: string | null = null;
  for (const c of candidates) {
    const got = Buffer.from(deriveRandomness(c.hash, roundId)).toString("hex");
    const hex = Buffer.from(c.hash).toString("hex");
    const ok = got === target;
    if (ok) match = c.label;
    console.log(`    ${ok ? "MATCH" : "     "}  ${c.label}`);
    console.log(`           blockhash ${hex}`);
    console.log(`           derived   ${got}`);
  }
  console.log(`\n  RESULT: ${match ? `the program used ${match}` : "NO candidate matched — the reveal value is not the blockhash of reveal_slot or its neighbours"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
