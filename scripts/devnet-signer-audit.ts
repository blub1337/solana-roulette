/**
 * Post-hoc signer audit for the B2 permissionless-settlement round.
 *
 *   npx tsx scripts/devnet-signer-audit.ts [roundKeyInStateFile]
 *
 * Reads the lock/settle/pay signatures recorded by
 * `scripts/devnet-permissionless-settle-e2e.ts` back off the devnet RPC and
 * prints WHO ACTUALLY SIGNED each transaction. The proof that settlement is
 * permissionless is not "the script called it" — it is that the operator
 * pubkey is absent from the signature set while a stranger pubkey is present.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { existsSync, readFileSync } from "node:fs";
import { configPda } from "../packages/sdk/src/index.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM = new PublicKey(
  process.env.ROULETTE_PROGRAM_ID || "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos"
);
const STATE_FILE = "test-ledger/e2e-state.json";

async function main() {
  if (!existsSync(STATE_FILE)) throw new Error(`${STATE_FILE} missing — run the E2E first`);
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  const pl = state.permissionless;
  if (!pl) throw new Error("no `permissionless` record in the state file");

  const c = new Connection(RPC, "confirmed");
  const cfg = (await c.getAccountInfo(configPda(PROGRAM), "confirmed"))!.data;
  const operator = new PublicKey(cfg.subarray(8, 40)).toBase58();
  const stranger = pl.stranger;

  console.log("B2 signer audit — read back from the devnet RPC");
  console.log(`round      ${pl.roundId}`);
  console.log(`operator   ${operator}`);
  console.log(`stranger   ${stranger}`);
  console.log(`same?      ${operator === stranger}\n`);

  let failures = 0;
  const steps: [string, string][] = [
    ["create_round (operator-gated by design)", pl.createSig],
    ["lock_round", pl.lockSig],
    ["settle_round", pl.settleSig],
    ["pay_winners", pl.paySig],
  ];

  for (const [label, sig] of steps) {
    const tx = await c.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx) {
      console.log(`  FAIL ${label}: ${sig} not found on devnet`);
      failures++;
      continue;
    }
    const keys = tx.transaction.message.accountKeys as unknown as { toBase58(): string }[];
    const n = tx.transaction.message.header.numRequiredSignatures;
    const signers = keys.slice(0, n).map((k) => k.toBase58());
    const operatorSigned = signers.includes(operator);
    const strangerSigned = signers.includes(stranger);

    let verdict: string;
    if (label.startsWith("create_round")) {
      // create_round legitimately still requires the operator.
      verdict = operatorSigned ? "ok   operator signed (expected)" : "FAIL operator did not sign";
      if (!operatorSigned) failures++;
    } else {
      const ok = !operatorSigned && strangerSigned;
      verdict = ok
        ? "ok   stranger signed, operator ABSENT"
        : `FAIL operatorSigned=${operatorSigned} strangerSigned=${strangerSigned}`;
      if (!ok) failures++;
    }
    console.log(`  ${verdict}  ${label}`);
    console.log(`         signers: ${signers.join(", ")}`);
    console.log(`         tx: ${sig}`);
  }

  // The deposits must be the participants, not the operator — a sanity check
  // that nothing about this round was quietly operator-driven.
  const strat = new PublicKey(stranger);
  for (const d of pl.depositSigs as string[]) {
    const tx = await c.getTransaction(d, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const keys = tx!.transaction.message.accountKeys as unknown as { toBase58(): string }[];
    const n = tx!.transaction.message.header.numRequiredSignatures;
    const signers = keys.slice(0, n).map((k) => k.toBase58());
    if (signers.includes(strat.toBase58())) {
      console.log(`  FAIL a deposit was signed by the stranger: ${d}`);
      failures++;
    }
  }
  if (pl.depositSigs?.length) {
    console.log(`  ok   no deposit was stranger-signed (${pl.depositSigs.length} deposits, operator-funded test wallets)`);
  }

  console.log(`\n${failures === 0 ? "SIGNER AUDIT: PASS" : `SIGNER AUDIT: ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("audit crashed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
