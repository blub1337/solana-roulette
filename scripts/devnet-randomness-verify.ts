/**
 * B1 E2E — prove the settled round's draw is INDEPENDENTLY reproducible.
 *
 *   npx tsx scripts/devnet-randomness-verify.ts <roundId>
 *
 * Reads the Round account straight off the devnet RPC and checks, without
 * trusting this repo's server:
 *
 *   1. the program persisted an entropy input (`reveal_input`) on-chain
 *   2. SHA256("roulette:reveal" ‖ round_id_le_u64 ‖ reveal_input), computed
 *      inline here, equals the on-chain `randomness`
 *   3. u128(randomness[0..16]) % total_weight equals the on-chain winning_ticket
 *   4. the cumulative-weight walk over the Participant accounts picks the
 *      on-chain winner
 *   5. fee = pot * fee_bps / 10_000 and payout = pot - fee match on-chain
 *   6. the live /api/round/:id/verify endpoint agrees, using the same input
 *   7. (control) getBlock(reveal_slot).blockhash does NOT reproduce the draw —
 *      this is why the input has to be persisted
 *
 * The signature of the payout is verified from the transaction's own balance
 * deltas. Prints no secrets.
 */
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createHash } from "node:crypto";
import {
  getRoundPda,
  getEscrowPda,
  decodeRound,
  fetchParticipantsForRound,
  deriveRandomness,
  computeTicket,
  selectWinner,
  computeFeeSplit,
} from "../packages/verification/src/index.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const API = process.env.API_BASE || "https://solana-roulette-api-gd7k.onrender.com";
const PROGRAM_ID = new PublicKey(
  process.env.ROULETTE_PROGRAM_ID || "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos"
);
const TREASURY = new PublicKey("6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR");

const roundId = BigInt(process.argv[2] ?? "0");
if (roundId === 0n) {
  console.error("usage: npx tsx scripts/devnet-randomness-verify.ts <roundId>");
  process.exit(1);
}

const connection = new Connection(RPC, "confirmed");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sol = (n: bigint) => `${Number(n) / LAMPORTS_PER_SOL} SOL`;

let failures = 0;
function check(name: string, pass: boolean, detail = ""): void {
  if (!pass) failures++;
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Recompute the draw from FIRST PRINCIPLES: raw SHA256 + raw u128 LE. */
function deriveIndependent(revealInput: Uint8Array, id: bigint): Uint8Array {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(id);
  return new Uint8Array(
    createHash("sha256")
      .update(Buffer.from("roulette:reveal", "utf8"))
      .update(idBuf)
      .update(Buffer.from(revealInput))
      .digest()
  );
}
function ticketIndependent(randomness: Uint8Array, totalWeight: bigint): bigint {
  const dv = new DataView(randomness.buffer, randomness.byteOffset, randomness.byteLength);
  return ((dv.getBigUint64(8, true) << 64n) | dv.getBigUint64(0, true)) % totalWeight;
}

async function main() {
  console.log(`\nB1 RANDOMNESS VERIFIABILITY — round ${roundId} (devnet)`);
  console.log(`rpc  ${RPC}\napi  ${API}\n`);

  const [roundPk] = getRoundPda(PROGRAM_ID, roundId);
  const acc = await connection.getAccountInfo(roundPk, "confirmed");
  if (!acc) throw new Error(`round ${roundId} account missing at ${roundPk.toBase58()}`);
  const r = decodeRound(acc.data);

  console.log(`round account ${roundPk.toBase58()}  (${acc.data.length} bytes)`);
  console.log(`  status        ${r.status}`);
  console.log(`  pot           ${r.pot} lamports`);
  console.log(`  fee_bps       ${r.feeBps}`);
  console.log(`  lock_slot     ${r.lockSlot}`);
  console.log(`  reveal_slot   ${r.revealSlot}`);
  console.log(`  entrants      ${r.participantCount}\n`);

  // ---- 1. the entropy input is persisted on-chain, by the program ----------
  console.log("1. persisted randomness input");
  const hasInput = r.revealInput.length === 32 && r.revealInput.some((b) => b !== 0);
  check("reveal_input is present and non-zero on the Round account", hasInput, hex(r.revealInput));
  if (!hasInput) {
    console.log("\n  round predates the redeploy that added reveal_input — nothing to verify.");
    process.exit(1);
  }

  // ---- 2. recompute entropy from the persisted input -----------------------
  console.log("\n2. independent entropy recomputation");
  const mine = deriveIndependent(r.revealInput, r.id);
  const twin = deriveRandomness(r.revealInput, r.id);
  check("inline SHA256 == @solana-roulette/verification twin", hex(mine) === hex(twin));
  check("recomputed randomness == on-chain randomness", hex(mine) === hex(r.randomness), hex(mine));
  if (hex(mine) !== hex(r.randomness)) {
    console.log(`           on-chain randomness: ${hex(r.randomness)}`);
  }

  // ---- 3. recompute the ticket --------------------------------------------
  console.log("\n3. independent winning-ticket recomputation");
  const participants = (await fetchParticipantsForRound(connection, PROGRAM_ID, roundPk))
    .slice()
    .sort((a, b) => a.index - b.index);
  const entries = participants.map((p) => ({
    id: p.wallet.toBase58(),
    amount: p.amount,
    weightStart: p.weightStart,
    index: p.index,
  }));
  const totalWeight = entries.reduce((a, e) => a + e.amount, 0n);
  check("participant weights sum to the pot", totalWeight === r.pot, `Σ=${totalWeight}`);

  const ticketMine = ticketIndependent(mine, r.totalWeight);
  const ticketTwin = computeTicket(mine, r.totalWeight);
  check("inline u128 ticket == verification twin", ticketMine === ticketTwin);
  check("recomputed ticket == on-chain winning_ticket", ticketMine === r.winningTicket, String(ticketMine));
  if (ticketMine !== r.winningTicket) console.log(`           on-chain ticket: ${r.winningTicket}`);

  // ---- 4. recompute the winner --------------------------------------------
  console.log("\n4. independent winner selection (cumulative-weight walk)");
  const picked = selectWinner(entries, ticketMine);
  check("recomputed winner == on-chain winner", picked.id === r.winner.toBase58(), picked.id);
  if (picked.id !== r.winner.toBase58()) console.log(`           on-chain winner: ${r.winner.toBase58()}`);

  // ---- 5. fee / payout ----------------------------------------------------
  console.log("\n5. fee + payout recomputation");
  const { fee, payout } = computeFeeSplit(r.pot, r.feeBps);
  check("fee == pot * fee_bps / 10000", fee === r.feeLamports, `${fee} (${(Number(fee) / Number(r.pot) * 100).toFixed(4)}%)`);
  check("payout == pot - fee", payout === r.payoutLamports, `${payout} (${(Number(payout) / Number(r.pot) * 100).toFixed(4)}%)`);
  check("payout + fee == pot exactly", payout + fee === r.pot, String(payout + fee));

  // ---- 6. the live API's own independent recompute agrees -------------------
  console.log("\n6. live /api/round/:id/verify");
  try {
    const res = await fetch(`${API}/api/round/${roundId}/verify`, { signal: AbortSignal.timeout(45_000) });
    const body: any = await res.json();
    const t = body?.trace ?? {};
    check("API /verify ok === true", body?.ok === true);
    check("API entropySource === persisted_input", t.entropySource === "persisted_input", String(t.entropySource));
    check("API revealInputHex == on-chain reveal_input", t.revealInputHex === hex(r.revealInput), String(t.revealInputHex));
    check("API randomnessHex == on-chain randomness", t.randomnessHex === hex(r.randomness), String(t.randomnessHex));
    check("API ticket == on-chain ticket", t.ticket === String(r.winningTicket), String(t.ticket));
    check("API computedWinner == on-chain winner", t.computedWinner === r.winner.toBase58(), String(t.computedWinner));
    check("API expectedFee == on-chain fee", t.expectedFeeLamports === String(r.feeLamports), String(t.expectedFeeLamports));
    check("API expectedPayout == on-chain payout", t.expectedPayoutLamports === String(r.payoutLamports), String(t.expectedPayoutLamports));
    const failed = (t.checks ?? []).filter((c: any) => !c.pass);
    check("every API check passed", failed.length === 0, failed.map((c: any) => c.name).join(", ") || "all green");
    if (r.revealInput) {
      const exposed = body?.round?.revealInputHex;
      check("API /api/round/:id exposes revealInputHex", exposed === hex(r.revealInput), String(exposed));
    }
  } catch (e) {
    check("API /verify reachable", false, (e as Error).message);
  }

  // ---- 7. control: the RPC blockhash can NOT reproduce the draw ------------
  console.log("\n7. control — getBlock(reveal_slot).blockhash does NOT reproduce the draw");
  const block = await connection.getBlock(Number(r.revealSlot), {
    maxSupportedTransactionVersion: 0,
    transactionDetails: "none",
    rewards: false,
  });
  if (!block) {
    console.log("  [----] reveal slot produced no block on this RPC — nothing to compare");
  } else {
    const bh = new Uint8Array(new PublicKey(block.blockhash).toBytes());
    const fromBlockhash = deriveIndependent(bh, r.id);
    check(
      "blockhash-derived randomness differs from the on-chain draw (as expected)",
      hex(fromBlockhash) !== hex(r.randomness),
      `getBlock(${r.revealSlot}).blockhash = ${block.blockhash}`
    );
  }

  // ---- 8. the real payout transaction -------------------------------------
  console.log("\n8. payout transaction on devnet");
  const sig = await findPayoutTx(r.id);
  if (!sig) {
    check("payout transaction located", false, "not found in the round's recent signatures");
  } else {
    const tx = await connection.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const keys = tx!.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
    const deltas: Record<string, bigint> = {};
    (tx!.meta?.preBalances ?? []).forEach((b, i) => {
      const d = BigInt(tx!.meta?.postBalances?.[i] ?? 0) - BigInt(b);
      if (d !== 0n) deltas[keys[i]] = d;
    });
    const [escrowPk] = getEscrowPda(PROGRAM_ID, roundPk);
    const w = r.winner.toBase58();
    console.log(`  signature ${sig}`);
    console.log(`  explorer  https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    check("tx succeeded on chain", !tx!.meta?.err, JSON.stringify(tx!.meta?.err ?? null));
    check("winner received 92.5% of the pot", deltas[w] === r.payoutLamports, `${deltas[w] ?? 0} = ${sol(deltas[w] ?? 0n)}`);
    check("treasury received 7.5% of the pot", deltas[TREASURY.toBase58()] === r.feeLamports, `${deltas[TREASURY.toBase58()] ?? 0} = ${sol(deltas[TREASURY.toBase58()] ?? 0n)}`);
    check("escrow drained exactly the pot", deltas[escrowPk.toBase58()] === -r.pot, String(deltas[escrowPk.toBase58()] ?? 0));
    check(
      "lamports conserved: payout + fee == escrow outflow",
      (deltas[w] ?? 0n) + (deltas[TREASURY.toBase58()] ?? 0n) === -(deltas[escrowPk.toBase58()] ?? 0n),
      `${deltas[w] ?? 0n} + ${deltas[TREASURY.toBase58()] ?? 0n} = ${-(deltas[escrowPk.toBase58()] ?? 0n)}`
    );
    const escrowNow = await connection.getBalance(escrowPk, "confirmed");
    check("escrow back to its rent floor (650,240)", escrowNow === 650_240, String(escrowNow));
  }

  console.log(`\n${failures === 0 ? "✅ B1 VERIFIED — the draw is independently reproducible on-chain" : `❌ ${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** Find the pay_winners signature that paid this round's winner. */
async function findPayoutTx(id: bigint): Promise<string | null> {
  const [roundPk] = getRoundPda(PROGRAM_ID, id);
  const [escrowPk] = getEscrowPda(PROGRAM_ID, roundPk);
  const escrow = escrowPk.toBase58();
  const sigs = await connection.getSignaturesForAddress(roundPk, { limit: 50 });
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await connection.getParsedTransaction(s.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx || tx.meta?.err) continue;
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
    const idx = keys.indexOf(escrow);
    if (idx < 0) continue;
    const delta = BigInt(tx.meta.postBalances[idx] ?? 0) - BigInt(tx.meta.preBalances[idx] ?? 0);
    if (delta < 0n) return s.signature;
  }
  return null;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
