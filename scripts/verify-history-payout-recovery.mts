/**
 * PROVE payout signatures are recovered from the CHAIN for real devnet rounds.
 *
 * The unit suite proves the recovery algorithm against a fake connection. This
 * proves it against live devnet, and proves the recovered signature is real by
 * checking the on-chain escrow balance drop by exactly the round pot.
 *
 * Read-only: no signing, no sending.
 *
 *   npx tsx scripts/verify-history-payout-recovery.mts
 */
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  decodeGlobalConfig,
  decodeRound,
  getEscrowPda,
  getGlobalConfigPda,
  getRoundPda,
} from "@solana-roulette/verification";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_ROULETTE_PROGRAM_ID ??
    "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos"
);

const connection = new Connection(RPC, "confirmed");

function accountKeysOf(
  tx: NonNullable<Awaited<ReturnType<Connection["getTransaction"]>>>
): PublicKey[] | null {
  const message = tx.transaction.message;
  if ("accountKeys" in message && Array.isArray(message.accountKeys)) {
    return message.accountKeys;
  }
  if (!("staticAccountKeys" in message)) return null;
  const loaded = tx.meta?.loadedAddresses;
  return [
    ...message.staticAccountKeys,
    ...(loaded?.writable ?? []),
    ...(loaded?.readonly ?? []),
  ];
}

async function main(): Promise<void> {
  const cfg = await connection.getAccountInfo(getGlobalConfigPda(PROGRAM_ID)[0]);
  if (!cfg) throw new Error("GlobalConfig missing");
  const counter = decodeGlobalConfig(cfg.data).roundCounter;

  let checked = 0;
  let recovered = 0;
  const failures: string[] = [];

  for (let id = 1n; id <= counter; id++) {
    const info = await connection.getAccountInfo(getRoundPda(PROGRAM_ID, id)[0]);
    if (!info?.data) continue;
    const r = decodeRound(info.data);
    if (r.status !== "COMPLETED" || r.pot === 0n) continue;

    const escrow = getEscrowPda(PROGRAM_ID, id)[0];
    const sigs = await connection.getSignaturesForAddress(escrow, { limit: 12 });
    let hit: string | null = null;
    for (const entry of sigs) {
      if (entry.err) continue;
      const tx = await connection.getTransaction(entry.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta) continue;
      const keys = accountKeysOf(tx);
      if (!keys) continue;
      const idx = keys.findIndex((k) => k.equals(escrow));
      if (idx < 0) continue;
      const pre = tx.meta.preBalances[idx];
      const post = tx.meta.postBalances[idx];
      if (pre === undefined || post === undefined) continue;
      if (BigInt(post) - BigInt(pre) === -r.pot) {
        hit = entry.signature;
        break;
      }
    }

    checked++;
    if (hit) {
      recovered++;
      console.log(
        `  ok   round ${id}  pot=${(Number(r.pot) / LAMPORTS_PER_SOL).toFixed(9)}  sig=${hit}`
      );
    } else {
      failures.push(`round ${id}: no escrow drop of exactly ${r.pot} found`);
      console.log(`  FAIL round ${id}  no matching escrow drop`);
    }
    await new Promise((x) => setTimeout(x, 300));
  }

  console.log("");
  console.log(`completed rounds checked: ${checked}`);
  console.log(`payout sigs recovered from chain: ${recovered}`);
  if (failures.length) {
    console.log("FAILURES:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else if (checked === 0) {
    console.log("no completed rounds to check");
  } else {
    console.log("RESULT: PASS");
  }
}

main().catch((e) => {
  console.error("verify failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
