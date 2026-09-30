/**
 * READ-ONLY: when did each funded round's escrow actually receive its lamports,
 * relative to the current program's deploy slot?
 *
 * This is what separates "pre-C1 legacy" from "post-C1" in the legacy-state
 * doc. A round locked before the deploy slot ran under the previous binary; one
 * locked at/after it ran under the current one.
 *
 *   npx tsx scripts/measure-devnet-round-history.mts
 */
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { decodeRound, getEscrowPda, getRoundPda } from "@solana-roulette/verification";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_ROULETTE_PROGRAM_ID ??
    "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos"
);
/** ProgramData creation slot = when the current binary went live. */
const DEPLOY_SLOT = 504558584n;

const ROUND_IDS = [1n, 6n, 7n, 13n, 21n, 24n, 25n, 26n, 27n, 28n, 58n, 66n];

const connection = new Connection(RPC, "confirmed");

async function main(): Promise<void> {
  console.log(`program    ${PROGRAM_ID.toBase58()}`);
  console.log(`deploy     slot ${DEPLOY_SLOT}`);
  console.log("");

  for (const id of ROUND_IDS) {
    const info = await connection.getAccountInfo(getRoundPda(PROGRAM_ID, id)[0]);
    if (!info?.data) {
      console.log(`round ${id}: MISSING`);
      continue;
    }
    const r = decodeRound(info.data);
    const escrow = getEscrowPda(PROGRAM_ID, id)[0];
    const sigs = await connection.getSignaturesForAddress(escrow, { limit: 25 });

    let firstFund: number | null = null;
    for (const s of [...sigs].reverse()) {
      if (s.err) continue;
      const tx = await connection.getTransaction(s.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      const msg = tx?.transaction.message;
      const loaded = tx?.meta?.loadedAddresses;
      const keys =
        msg && "accountKeys" in msg && Array.isArray(msg.accountKeys)
          ? msg.accountKeys
          : msg && "staticAccountKeys" in msg
            ? [...msg.staticAccountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])]
            : [];
      const idx = keys.findIndex((k) => k.equals(escrow));
      if (idx < 0) continue;
      const pre = tx!.meta!.preBalances[idx];
      const post = tx!.meta!.postBalances[idx];
      if (post > pre) {
        firstFund = tx!.slot;
        break;
      }
    }

    const era =
      firstFund !== null && BigInt(firstFund) >= DEPLOY_SLOT
        ? "POST-C1"
        : firstFund !== null
          ? "pre-C1"
          : "no-funding-found";
    console.log(
      [
        `round ${id}`.padEnd(11),
        r.status.padEnd(19),
        `pot=${(Number(r.pot) / LAMPORTS_PER_SOL).toFixed(9)}`.padEnd(16),
        `lockSlot=${r.lockSlot}`.padEnd(20),
        `firstFundSlot=${firstFund ?? "-"}`.padEnd(20),
        era,
      ].join(" ")
    );
    await new Promise((x) => setTimeout(x, 250));
  }
}

main().catch((e) => {
  console.error("measure failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
