/**
 * Bounded search for the entropy value the program consumed: scan blockhashes
 * of slots around reveal_slot and see which one reproduces the randomness
 * frozen on the Round account.
 *
 *   npx tsx scripts/devnet-reveal-scan.ts <roundId> [window]
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { getRoundPda, deriveRandomness } from "../packages/verification/src/index.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.ROULETTE_PROGRAM_ID || "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos"
);
const connection = new Connection(RPC, "confirmed");

function decodeRound(buf: Buffer) {
  return {
    revealSlot: buf.readBigUInt64LE(85),
    randomness: Buffer.from(buf.subarray(95, 127)).toString("hex"),
  };
}

async function main() {
  const roundId = BigInt(process.argv[2] ?? 7);
  const window = Number(process.argv[3] ?? 15);
  const [rk] = getRoundPda(PROGRAM_ID, roundId);
  const r = decodeRound((await connection.getAccountInfo(rk, "confirmed"))!.data);
  const target = r.randomness;
  console.log(`round ${roundId}: reveal_slot ${r.revealSlot}, randomness ${target}`);
  console.log(`scanning blockhashes of slots ${r.revealSlot}-${window} .. ${r.revealSlot}+${window}\n`);

  const centre = Number(r.revealSlot);
  let found: string | null = null;
  let checked = 0;
  for (let s = centre - window; s <= centre + window; s++) {
    if (s < 0) continue;
    let hash: string;
    try {
      const b: any = await connection.getBlock(s, {
        maxSupportedTransactionVersion: 1,
        transactionDetails: "none",
        rewards: false,
      });
      if (!b) continue;
      hash = b.blockhash as string;
    } catch {
      continue;
    }
    checked++;
    const derived = Buffer.from(
      deriveRandomness(new Uint8Array(new PublicKey(hash).toBytes()), roundId)
    ).toString("hex");
    if (derived === target) {
      found = `slot ${s} blockhash ${hash}`;
      console.log(`  MATCH  slot ${s}`);
      console.log(`         blockhash  ${hash}`);
      console.log(`         derived    ${derived}`);
      break;
    }
  }
  console.log(`\n  checked ${checked} slots`);
  console.log(
    found
      ? `  RESULT: the program hashed the blockhash of ${found}`
      : "  RESULT: no blockhash in the window reproduces the on-chain randomness"
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
