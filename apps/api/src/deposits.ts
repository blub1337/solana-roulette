/**
 * REAL devnet deposits.
 *
 *   1. the client asks for an intent  → server answers with the escrow address
 *                                        and opens a PENDING tx record
 *   2. the client builds a REAL SystemProgram.transfer, its wallet signs it
 *   3. the client sends it to the devnet RPC and waits for confirmation
 *   4. the client reports the signature → the server RE-READS the transaction
 *      from the chain and only then credits the round and moves the record to
 *      CONFIRMED
 *
 * Nothing is credited on the client's word. A rejected signature, a failed
 * transaction, an unknown signature or a mismatched amount all end in FAILED
 * with the round untouched. The idempotency key `deposit:<round>:<wallet>`
 * makes a refresh, a double click or a retry resume the SAME record instead of
 * creating a second one.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import type { AppConfig } from "@solana-roulette/config";
import type { ChainBackend } from "./backend.js";
import { store, broadcast } from "./store.js";
import { depositAttemptOf, depositKey, txToDto, TxStateError, type ChainTx } from "./txLedger.js";
import { checkSystemTransfer, logRpcView, COMMITMENT } from "./onchain.js";
import { requireCustody, type Custody, DEVNET_EXPLORER_TX } from "./custody.js";
import { depositState } from "./adminState.js";
import { txLog } from "./logger.js";
import { LocalLedgerError } from "./localLedger.js";
import { tierCapLamports } from "./settlement.js";
import { getEscrowPda } from "@solana-roulette/verification";

export class DepositError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 422
  ) {
    super(message);
    this.name = "DepositError";
  }
}

export interface DepositDeps {
  backend: ChainBackend;
  connection: Connection;
  custody: Custody;
  cfg: AppConfig;
  /** Used to derive the program escrow PDA when the Anchor program is live. */
  programId: PublicKey;
}

export interface DepositIntent {
  depositId: string;
  /** Devnet System account that must receive the transfer. */
  escrow: string;
  amountLamports: string;
  roundId: string;
  tier: number;
  network: "devnet";
  commitment: typeof COMMITMENT;
  /** Existing intent for the same wallet+round → the client must not re-send. */
  resumed: boolean;
  status: "PENDING" | "CONFIRMED" | "FAILED";
  signature: string | null;
  explorer: string | null;
}

/** Open (or resume) a PENDING deposit for a wallet in a round. */
export async function createDepositIntent(
  deps: DepositDeps,
  args: { roundId: bigint; wallet: PublicKey; amountLamports: bigint }
): Promise<DepositIntent> {
  const { backend, custody, cfg } = deps;
  requireCustody(custody);

  // Operator kill switch: refuse to open NEW deposit intents while paused.
  // A deposit that is already in flight stays confirmable — its lamports are
  // on the chain already and must never be stranded by an operator action.
  const switchState = depositState();
  if (switchState.paused) {
    throw new DepositError(
      "deposits_paused",
      `deposits are ${switchState.state.toLowerCase()} by the operator: ${switchState.reason}`,
      503
    );
  }

  const { roundId, wallet, amountLamports } = args;
  const round = await backend.getRound(roundId);
  if (!round) throw new DepositError("round_not_found", `round ${roundId} does not exist`, 404);
  if (round.status !== "OPEN") {
    throw new DepositError("round_not_open", `round ${roundId} is ${round.status}`, 409);
  }
  if (amountLamports < cfg.minDepositLamports) {
    throw new DepositError("DepositTooSmall", `${amountLamports} < ${cfg.minDepositLamports}`);
  }
  if (amountLamports > cfg.maxDepositLamports) {
    throw new DepositError("DepositTooLarge", `${amountLamports} > ${cfg.maxDepositLamports}`);
  }
  const cap = tierCapLamports(cfg, round.tier);
  if (round.pot + amountLamports > cap) {
    throw new DepositError(
      "RoundOverCap",
      `pot would be ${round.pot + amountLamports} > tier cap ${cap} (rejected, never truncated)`
    );
  }

  const wallet58 = wallet.toBase58();
  const confirmed = store.txs.getConfirmedDeposit(roundId, wallet58);
  if (confirmed) {
    throw new DepositError("already_deposited", "this wallet already has a confirmed entry in this round", 409);
  }
  const existing = store.txs.getDeposit(roundId, wallet58);
  if (existing?.depositStatus === "PENDING") {
    // Same wallet, same round, still in flight: hand back the SAME record so a
    // refresh or a double click can never create a second transfer.
    return toIntent(existing, true);
  }
  // A FAILED attempt is terminal, but it must not lock the wallet out of the
  // round: the next click opens a NEW attempt with its own idempotency key
  // (exactly how payouts retry). The CONFIRMED guard above is what still
  // prevents a second entry.
  const attempt = existing ? depositAttemptOf(existing) + 1 : 1;

  const { tx } = store.txs.begin({
    kind: "DEPOSIT",
    idempotencyKey: depositKey(roundId, wallet58, attempt),
    roundId: roundId.toString(),
    tier: round.tier,
    wallet: wallet58,
    recipient: depositRecipient(deps, roundId).toBase58(),
    network: custody.cluster,
    depositAmountLamports: amountLamports.toString(),
  });
  return toIntent(tx, false);
}

/**
 * Where the player's lamports must land: the round's program escrow when the
 * Anchor program is deployed, otherwise the devnet custody escrow.
 */
function depositRecipient(deps: DepositDeps, roundId: bigint): PublicKey {
  if (deps.backend.mode === "chain") return getEscrowPda(deps.programId, roundId)[0];
  return requireCustody(deps.custody).escrow!;
}

/**
 * Verify a submitted deposit on chain and credit the round ONLY if it really
 * moved the player's own lamports into the escrow.
 */
export async function confirmDeposit(
  deps: DepositDeps,
  args: { depositId: string; signature: string }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { backend, connection, custody } = deps;
  const existing = store.txs.get(args.depositId);
  if (!existing) {
    return { status: 404, body: { error: "deposit_not_found", detail: "unknown deposit id" } };
  }
  if (existing.kind !== "DEPOSIT") {
    return { status: 400, body: { error: "wrong_tx_kind", detail: "not a deposit" } };
  }
  if (existing.depositStatus === "CONFIRMED") {
    // Idempotent replay after a refresh: return the same confirmed result.
    return { status: 200, body: await confirmedBody(existing, backend) };
  }
  if (existing.depositStatus === "FAILED") {
    return {
      status: 409,
      body: { ...txToDto(existing), error: existing.lastError ?? "deposit_failed" },
    };
  }

  const wallet = new PublicKey(existing.wallet);
  const escrow = new PublicKey(existing.recipient);
  const amount = BigInt(existing.depositAmountLamports ?? "0");

  let check;
  try {
    check = await checkSystemTransfer(connection, {
      signature: args.signature,
      from: wallet,
      to: escrow,
      amount,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    store.txs.failPending(existing.id, detail);
    logRpcView("deposit.verify_failed", {
      signature: args.signature,
      network: custody.cluster,
      ok: false,
      code: "rpc_error",
      detail,
    });
    return { status: 502, body: { error: "rpc_error", detail } };
  }

  if (!check.ok) {
    // Not yet visible on RPC is NOT a failure: stay PENDING and let the client
    // poll. Anything else is terminal.
    if (check.code === "tx_not_found") {
      txLog.info("deposit.pending_confirmation", {
        id: existing.id,
        roundId: existing.roundId,
        wallet: existing.wallet,
        network: custody.cluster,
        signature: args.signature,
        status: "PENDING",
      });
      return { status: 202, body: { ...txToDto(existing), status: "PENDING" } };
    }
    store.txs.failPending(existing.id, `${check.code}: ${check.detail}`);
    logRpcView("deposit.verify_failed", {
      signature: args.signature,
      network: custody.cluster,
      ok: false,
      code: check.code,
      detail: check.detail,
    });
    return {
      status: 422,
      body: { error: check.code, detail: check.detail, depositId: existing.id, credited: false },
    };
  }

  // Signature is real, error-free and moved the player's own lamports into the
  // escrow. Bind it, then credit.
  try {
    store.txs.attachSignature(existing.id, args.signature);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { status: 409, body: { error: "signature_conflict", detail, credited: false } };
  }

  const roundId = BigInt(existing.roundId);
  try {
    await backend.deposit({ roundId, wallet, lamports: check.transfer.amount });
  } catch (err) {
    if (err instanceof LocalLedgerError) {
      // The money arrived but the round rejected it (cap/duplicate/status).
      // Record the failure — the pot is NOT credited.
      store.txs.failPending(existing.id, `${err.code}: ${err.message}`);
      return {
        status: err.code === "DuplicateDeposit" ? 409 : 422,
        body: { error: err.code, detail: err.message, depositId: existing.id, credited: false },
      };
    }
    const detail = err instanceof Error ? err.message : String(err);
    store.txs.failPending(existing.id, detail);
    store.mirrorFailure("deposit.credit", detail);
    return { status: 500, body: { error: "credit_failed", detail, credited: false } };
  }

  const confirmed = store.txs.settle(existing.id, "CONFIRMED", {
    signature: args.signature,
    confirmedAt: new Date(),
  });
  const round = await backend.getRound(roundId);
  store.upsertRound({
    id: roundId.toString(),
    tier: round?.tier ?? confirmed.tier,
    status: round?.status ?? "OPEN",
    pot: round?.pot.toString() ?? "0",
  });

  logRpcView("deposit.confirmed", {
    signature: args.signature,
    network: custody.cluster,
    ok: true,
    slot: check.slot,
  });
  txLog.info("deposit.credited", {
    id: confirmed.id,
    roundId: confirmed.roundId,
    tier: confirmed.tier,
    wallet: confirmed.wallet,
    amountLamports: confirmed.depositAmountLamports,
    recipient: confirmed.recipient,
    network: confirmed.network,
    signature: args.signature,
    explorer: DEVNET_EXPLORER_TX(args.signature),
    potLamports: round?.pot.toString() ?? "0",
  });

  const body = await confirmedBody(confirmed, backend);
  broadcast({ type: "deposit", roundId: confirmed.roundId, data: body });
  broadcast({
    type: "pot",
    roundId: confirmed.roundId,
    data: {
      potLamports: round?.pot.toString() ?? "0",
      participantCount: round?.participantCount ?? 0,
      tier: round?.tier ?? confirmed.tier,
    },
  });
  broadcast({
    type: "participant",
    roundId: confirmed.roundId,
    data: {
      wallet: confirmed.wallet,
      amountLamports: confirmed.depositAmountLamports,
      tier: round?.tier ?? confirmed.tier,
    },
  });
  void custody;
  return { status: 200, body };
}

/** The player rejected in their wallet, or the send failed: never credit. */
export function cancelDeposit(depositId: string, reason: string): { status: number; body: Record<string, unknown> } {
  const tx = store.txs.get(depositId);
  if (!tx) return { status: 404, body: { error: "deposit_not_found" } };
  if (tx.depositStatus === "CONFIRMED") {
    return { status: 409, body: { ...txToDto(tx), error: "already_confirmed" } };
  }
  if (tx.depositStatus === "FAILED") {
    return { status: 200, body: txToDto(tx) };
  }
  const failed = store.txs.failPending(depositId, `rejected: ${reason}`.slice(0, 300));
  txLog.warn("deposit.rejected", {
    id: failed.id,
    roundId: failed.roundId,
    wallet: failed.wallet,
    network: failed.network,
    amountLamports: failed.depositAmountLamports,
    signature: failed.depositSignature,
    status: "FAILED",
    error: reason,
  });
  return { status: 200, body: txToDto(failed) };
}

/**
 * Reconciler: a PENDING deposit that never made it to the chain (closed tab,
 * rejected signature, dropped RPC) must not stay PENDING forever, and must
 * never be credited. Anything old enough with a signature is re-verified
 * against the chain; anything without one is failed.
 */
export async function reconcilePendingDeposits(
  deps: DepositDeps,
  ageMs = 45_000
): Promise<{ checked: number; confirmed: number; failed: number }> {
  const stale = store.txs.listStalePending(ageMs);
  let confirmed = 0;
  let failed = 0;
  for (const tx of stale) {
    if (tx.depositSignature) {
      const result = await confirmDeposit(deps, { depositId: tx.id, signature: tx.depositSignature });
      if (result.status === 200) {
        confirmed++;
        continue;
      }
      if (result.status === 202) continue; // still landing on chain
      failed++;
      continue;
    }
    store.txs.failPending(tx.id, "expired: no transaction was ever submitted");
    txLog.warn("deposit.expired", {
      id: tx.id,
      roundId: tx.roundId,
      wallet: tx.wallet,
      network: tx.network,
      amountLamports: tx.depositAmountLamports,
      signature: null,
      status: "FAILED",
      error: "expired: no transaction was ever submitted",
    });
    failed++;
  }
  if (stale.length > 0) {
    txLog.info("deposit.reconciled", {
      checked: stale.length,
      confirmed,
      failed,
      network: deps.custody.cluster,
    });
  }
  return { checked: stale.length, confirmed, failed };
}

function toIntent(tx: ChainTx, resumed: boolean): DepositIntent {
  return {
    depositId: tx.id,
    escrow: tx.recipient,
    amountLamports: tx.depositAmountLamports ?? "0",
    roundId: tx.roundId,
    tier: tx.tier,
    network: "devnet",
    commitment: COMMITMENT,
    resumed,
    status: tx.depositStatus ?? "PENDING",
    signature: tx.depositSignature,
    explorer: tx.depositSignature ? DEVNET_EXPLORER_TX(tx.depositSignature) : null,
  };
}

async function confirmedBody(
  tx: ChainTx,
  backend: ChainBackend
): Promise<Record<string, unknown>> {
  const round = await backend.getRound(BigInt(tx.roundId));
  return {
    ...txToDto(tx),
    ok: true,
    credited: true,
    potLamports: round?.pot.toString() ?? "0",
    participantCount: round?.participantCount ?? 0,
    roundStatus: round?.status ?? "OPEN",
  };
}

export { TxStateError };
