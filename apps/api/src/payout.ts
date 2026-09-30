/**
 * REAL devnet payouts.
 *
 *   1. the round has a frozen winner and a pot made only of CONFIRMED deposits
 *   2. the pot is recomputed FROM the confirmed deposits (never from a client
 *      value) and split 2% platform fee / 98% winner, integer lamports
 *   3. the server signs ONE transaction that moves fee → fee wallet and
 *      payout → winner, and sends it to the devnet RPC
 *   4. the transaction is re-read from the chain and must be error-free with
 *      exactly those transfers
 *   5. only then is the record CONFIRMED and the round allowed to complete
 *
 * A payout is never marked done because a database row changed: the chain
 * decides. If anything is wrong (no confirmed deposits, not enough escrow
 * balance, RPC error, on-chain failure) the record goes to FAILED with a
 * reason and the round stays open for a retry.
 */
import {
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  type Connection,
} from "@solana/web3.js";
import type { AppConfig } from "@solana-roulette/config";
import { computeFeeSplit } from "@solana-roulette/verification";
import type { ChainBackend } from "./backend.js";
import { store } from "./store.js";
import { payoutKey, payoutAttemptOf, type ChainTx } from "./txLedger.js";
import { COMMITMENT, checkSystemTransfer, fetchParsedTransaction, extractSystemTransfers, logRpcView } from "./onchain.js";
import { requireCustody, type Custody, DEVNET_EXPLORER_TX, TX_FEE_BUFFER_LAMPORTS } from "./custody.js";
import { txLog } from "./logger.js";

/** A submitted payout that cannot be found on chain after this long is treated
 *  as lost (never as paid) and may be retried as a new attempt. */
const RESUME_GRACE_MS = 120_000;

/**
 * Payouts currently in flight, keyed by round.
 *
 * `ensureRoundPaid` is documented as safe to call on every settlement tick, so
 * the function itself has to survive concurrent callers. Without this guard two
 * overlapping calls (two ticks, or a tick plus a manual retry) both pass the
 * "already paid?" check, both resolve the SAME payout record through the same
 * idempotency key, and both broadcast a transfer — the winner is paid twice and
 * the second send only fails afterwards, when its signature collides with the
 * first. Serialising per round closes that window: the second caller awaits the
 * first caller's outcome instead of starting a second payment.
 */
const inFlightPayouts = new Map<string, Promise<PayoutOutcome>>();

export interface PayoutDeps {
  backend: ChainBackend;
  connection: Connection;
  custody: Custody;
  cfg: AppConfig;
}

export interface PayoutTarget {
  roundId: bigint;
  tier: number;
  winner: string;
}

/** What the settlement driver depends on (mockable in tests). */
export interface PayoutService {
  ensureRoundPaid(target: PayoutTarget): Promise<PayoutOutcome>;
}

export type PayoutOutcome =  | {
      status: "CONFIRMED";
      signature: string;
      winner: string;
      payoutLamports: bigint;
      feeLamports: bigint;
      alreadyPaid: boolean;
    }
  | { status: "PENDING" | "FAILED" | "SKIPPED"; reason: string; winner?: string; payoutLamports?: bigint; feeLamports?: bigint };

/**
 * Make sure the winner of `target` has been paid, on chain, exactly once.
 * Safe to call on every settlement tick: an already CONFIRMED payout returns
 * immediately without sending anything, and a call that arrives while the same
 * round is still being paid shares that payment's result.
 */
export function ensureRoundPaid(deps: PayoutDeps, target: PayoutTarget): Promise<PayoutOutcome> {
  const key = target.roundId.toString();
  const running = inFlightPayouts.get(key);
  if (running) {
    txLog.warn("payout.joined_in_flight", { roundId: key, status: "PENDING" });
    return running;
  }
  const attempt = payRoundOnce(deps, target).finally(() => {
    inFlightPayouts.delete(key);
  });
  inFlightPayouts.set(key, attempt);
  return attempt;
}

/** The actual payment attempt; `ensureRoundPaid` owns the concurrency guard. */
async function payRoundOnce(deps: PayoutDeps, target: PayoutTarget): Promise<PayoutOutcome> {
  const { connection, custody, cfg } = deps;
  if (!custody.ready) return { status: "SKIPPED", reason: custody.reason };

  const roundId = target.roundId.toString();

  // 1. Duplicate-payout guard: a CONFIRMED payout is final, forever.
  const confirmed = store.txs.getConfirmedPayout(roundId);
  if (confirmed) {
    txLog.info("payout.already_paid", {
      roundId,
      wallet: confirmed.wallet,
      amountLamports: confirmed.payoutAmountLamports,
      signature: confirmed.depositSignature,
      network: custody.cluster,
      status: "CONFIRMED",
    });
    return {
      status: "CONFIRMED",
      signature: confirmed.depositSignature ?? "",
      winner: confirmed.wallet,
      payoutLamports: BigInt(confirmed.payoutAmountLamports ?? "0"),
      feeLamports: BigInt(confirmed.feeLamports ?? "0"),
      alreadyPaid: true,
    };
  }

  // 2. The pot is the sum of CONFIRMED deposits. Nothing else may be paid.
  const pot = store.txs.confirmedPotLamports(roundId);
  if (pot <= 0n) {
    return failNoDeposits(deps, target, "no confirmed deposits for this round");
  }
  const { fee, payout } = computeFeeSplit(pot, cfg.feeBps);
  if (payout <= 0n) {
    return failNoDeposits(deps, target, `payout split produced ${payout} lamports`);
  }

  const winner = new PublicKey(target.winner);
  const previous = store.txs.latestPayout(roundId);

  // 3. Resume an in-flight attempt before starting a new one.
  if (previous && previous.payoutStatus === "PENDING") {
    const resumed = await resumeAttempt(deps, previous, { winner, payout, fee });
    if (resumed) return resumed;
  }
  if (previous && previous.payoutStatus === "FAILED" && previous.nextRetryAt) {
    if (previous.nextRetryAt.getTime() > Date.now()) {
      return { status: "PENDING", reason: `retry backoff until ${previous.nextRetryAt.toISOString()}` };
    }
  }

  // 4. New attempt.
  const attempt = (previous ? payoutAttemptOf(previous) : 0) + 1;
  const { tx: record } = store.txs.begin({
    kind: "PAYOUT",
    idempotencyKey: payoutKey(roundId, attempt),
    roundId,
    tier: target.tier,
    wallet: winner.toBase58(),
    recipient: winner.toBase58(),
    network: custody.cluster,
    payoutAmountLamports: payout.toString(),
    feeLamports: fee.toString(),
  });
  return sendPayout(deps, record, { winner, payout, fee, pot });
}

interface Split {
  winner: PublicKey;
  payout: bigint;
  fee: bigint;
}

/**
 * A PENDING attempt is only retried once the chain proves it moved nothing:
 * CONFIRMED → done, failed on chain → new attempt, absent after the grace
 * window → new attempt. Anything else waits.
 */
async function resumeAttempt(
  deps: PayoutDeps,
  record: ChainTx,
  split: Split
): Promise<PayoutOutcome | null> {
  const { connection, custody } = deps;
  const signature = record.depositSignature;
  if (!signature) return null; // never broadcast: same record is reused
  const winner = new PublicKey(record.wallet);
  const payout = BigInt(record.payoutAmountLamports ?? "0");
  const fee = BigInt(record.feeLamports ?? "0");

  const check = await checkPayoutTx(connection, signature, custody, winner, payout, fee);
  if (check.ok) {
    const settled = store.txs.settle(record.id, "CONFIRMED", { signature, confirmedAt: new Date() });
    return {
      status: "CONFIRMED",
      signature,
      winner: settled.wallet,
      payoutLamports: BigInt(settled.payoutAmountLamports ?? "0"),
      feeLamports: BigInt(settled.feeLamports ?? "0"),
      alreadyPaid: false,
    };
  }
  if (check.code === "tx_not_found") {
    const age = Date.now() - record.createdAt.getTime();
    if (age < RESUME_GRACE_MS) {
      return { status: "PENDING", reason: `attempt ${record.attempts} still within the confirmation grace window` };
    }
    // The chain never saw it: safe to start a new attempt.
    try {
      store.txs.settle(record.id, "FAILED", { error: `abandoned: ${check.detail}` });
    } catch {
      /* already terminal */
    }
    return null;
  }
  if (check.code === "tx_failed_on_chain") {
    try {
      store.txs.settle(record.id, "FAILED", { signature, error: `failed on chain: ${check.detail}` });
    } catch {
      /* already terminal */
    }
    return null;
  }
  return { status: "PENDING", reason: `${check.code}: ${check.detail}` };
}

async function sendPayout(
  deps: PayoutDeps,
  record: ChainTx,
  split: Split & { pot: bigint }
): Promise<PayoutOutcome> {
  const { connection, custody } = deps;
  const signer = requireCustody(custody).signer!;
  const { winner, payout, fee, pot } = split;

  // Escrow solvency check: never broadcast a transfer the pool cannot fund.
  const balance = BigInt(await connection.getBalance(signer.publicKey, COMMITMENT));
  if (balance < pot + TX_FEE_BUFFER_LAMPORTS) {
    const reason = `escrow balance ${balance} lamports is below pot ${pot} + buffer ${TX_FEE_BUFFER_LAMPORTS}`;
    store.txs.settle(record.id, "FAILED", { error: reason });
    txLog.error("payout.insufficient_escrow", {
      id: record.id,
      roundId: record.roundId,
      wallet: record.wallet,
      amountLamports: payout.toString(),
      feeLamports: fee.toString(),
      network: custody.cluster,
      signature: null,
      status: "FAILED",
      error: reason,
      escrowBalanceLamports: balance.toString(),
    });
    return { status: "FAILED", reason };
  }

  const tx = new Transaction();
  if (fee > 0n) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: custody.feeWallet,
        lamports: fee,
      })
    );
  }
  tx.add(
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: winner,
      lamports: payout,
    })
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(COMMITMENT);
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = signer.publicKey;

  let signature: string;
  try {
    signature = await sendAndConfirmTransaction(connection, tx, [signer], {
      commitment: COMMITMENT,
      preflightCommitment: COMMITMENT,
      maxRetries: 3,
    });
    store.txs.attachSignature(record.id, signature);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    try {
      store.txs.settle(record.id, "FAILED", { error: detail });
    } catch {
      /* already terminal */
    }
    txLog.error("payout.send_failed", {
      id: record.id,
      roundId: record.roundId,
      wallet: record.wallet,
      amountLamports: payout.toString(),
      feeLamports: fee.toString(),
      network: custody.cluster,
      signature: null,
      status: "FAILED",
      error: detail,
    });
    return { status: "FAILED", reason: detail };
  }

  // Verify against the chain — never trust the send() return value alone.
  const check = await checkPayoutTx(connection, signature, custody, winner, payout, fee);
  logRpcView("payout.sent", {
    signature,
    network: custody.cluster,
    ok: true,
    slot: check.ok ? check.slot : undefined,
  });
  if (!check.ok) {
    const detail = `${check.code}: ${check.detail}`;
    if (check.code !== "tx_not_found") {
      try {
        store.txs.settle(record.id, "FAILED", { signature, error: detail });
      } catch {
        /* already terminal */
      }
      txLog.error("payout.verify_failed", {
        id: record.id,
        roundId: record.roundId,
        wallet: record.wallet,
        amountLamports: payout.toString(),
        network: custody.cluster,
        signature,
        status: "FAILED",
        error: detail,
      });
      return { status: "FAILED", reason: detail };
    }
    return { status: "PENDING", reason: "submitted, waiting for confirmation" };
  }

  const settled = store.txs.settle(record.id, "CONFIRMED", {
    signature,
    confirmedAt: new Date(),
  });
  txLog.info("payout.confirmed", {
    id: settled.id,
    roundId: settled.roundId,
    tier: settled.tier,
    wallet: settled.wallet,
    amountLamports: settled.payoutAmountLamports,
    feeLamports: settled.feeLamports,
    feeWallet: custody.feeWallet.toBase58(),
    network: custody.cluster,
    signature,
    explorer: DEVNET_EXPLORER_TX(signature),
    status: "CONFIRMED",
  });
  return {
    status: "CONFIRMED",
    signature,
    winner: settled.wallet,
    payoutLamports: BigInt(settled.payoutAmountLamports ?? "0"),
    feeLamports: BigInt(settled.feeLamports ?? "0"),
    alreadyPaid: false,
  };
}

function failNoDeposits(deps: PayoutDeps, target: PayoutTarget, reason: string): PayoutOutcome {
  txLog.error("payout.blocked", {
    roundId: target.roundId.toString(),
    tier: target.tier,
    wallet: target.winner,
    network: deps.custody.cluster,
    signature: null,
    status: "FAILED",
    error: reason,
  });
  return { status: "FAILED", reason };
}

type PayoutCheck =
  | { ok: true; slot: number }
  | { ok: false; code: string; detail: string };

/** A payout is only real if BOTH transfers landed with the exact amounts. */
async function checkPayoutTx(
  connection: Connection,
  signature: string,
  custody: Custody,
  winner: PublicKey,
  payout: bigint,
  fee: bigint
): Promise<PayoutCheck> {
  const signer = custody.signer;
  if (!signer) return { ok: false, code: "no_signer", detail: custody.reason };

  const payoutCheck = await checkSystemTransfer(connection, {
    signature,
    from: signer.publicKey,
    to: winner,
    amount: payout,
  });
  if (!payoutCheck.ok) return payoutCheck;

  if (fee > 0n) {
    const feeCheck = await checkSystemTransfer(connection, {
      signature,
      from: signer.publicKey,
      to: custody.feeWallet,
      amount: fee,
    });
    if (!feeCheck.ok) return feeCheck;
  }

  // Total outflow must equal pot: no extra lamports can leave the escrow.
  const tx = await fetchParsedTransaction(connection, signature);
  if (tx) {
    const outflow = extractSystemTransfers(tx)
      .filter((t) => t.from.equals(signer.publicKey))
      .reduce((sum, t) => sum + t.amount, 0n);
    if (outflow !== payout + fee) {
      return {
        ok: false,
        code: "unexpected_outflow",
        detail: `escrow sent ${outflow} lamports, expected ${payout + fee}`,
      };
    }
  }
  return { ok: true, slot: payoutCheck.slot };
}
