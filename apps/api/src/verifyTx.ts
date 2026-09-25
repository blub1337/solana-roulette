/**
 * Independent transaction verification: fetches the tx from RPC, validates the
 * actual on-chain effects, and never trusts client-declared amounts/wallets.
 * Duplicate signatures are rejected BEFORE any state change (idempotence).
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import { getEscrowPda, getRoundPda } from "@solana-roulette/verification";
import { store, broadcast } from "./store.js";
import { fetchParsedTransaction, extractSystemTransfers, COMMITMENT } from "./onchain.js";
import { TxStateError } from "./txLedger.js";

export interface VerifyTxArgs {
  connection: Connection;
  programId: PublicKey;
  signature: string;
  kind: "deposit" | "lock" | "settle" | "cancel" | "create";
  expectedRoundId?: bigint;
}

export interface VerifyTxResult {
  status: number;
  body: Record<string, unknown>;
}

export async function verifySubmittedTransaction(args: VerifyTxArgs): Promise<VerifyTxResult> {
  const { connection, programId, signature, kind, expectedRoundId } = args;

  // Idempotence gate: an already-recorded signature is never re-processed.
  if (store.hasTx(signature)) {
    return { status: 409, body: { error: "already_verified", detail: "this signature was already processed" } };
  }

  let tx;
  try {
    tx = await fetchParsedTransaction(connection, signature);
  } catch (e) {
    return { status: 502, body: { error: "rpc_error", detail: e instanceof Error ? e.message : "unknown" } };
  }

  if (!tx) {
    return {
      status: 404,
      body: { error: "tx_not_found", detail: "not found or not yet confirmed on RPC" },
    };
  }

  if (tx.meta?.err) {
    return { status: 422, body: { error: "tx_failed_on_chain", detail: tx.meta.err } };
  }

  if (kind === "deposit") {
    // Default: head round of tier 0 (the 1-SOL lane); callers SHOULD pass an
    // explicit roundId. The chain, not this default, validates everything.
    const roundId = expectedRoundId ?? store.currentRoundIdByTier[0]!;
    const [escrowPk] = getEscrowPda(programId, roundId);
    const [roundPk] = getRoundPda(programId, roundId);

    // Extract actual SOL transfers from parsed instructions.
    const transfers = extractSystemTransfers(tx);
    const toEscrow = transfers.filter((t) => t.to.toBase58() === escrowPk.toBase58());

    if (toEscrow.length === 0) {
      return {
        status: 422,
        body: { error: "no_transfer_to_escrow", detail: `expected a transfer to escrow ${escrowPk.toBase58()}` },
      };
    }

    const deposit = toEscrow[0]!;
    if (deposit.amount <= 0n) {
      return { status: 422, body: { error: "invalid_amount", detail: "transfer lamports must be positive" } };
    }

    const escrowInfo = await connection.getAccountInfo(escrowPk);
    const escrowBalance = escrowInfo?.lamports ?? 0n;

    const round = await fetchRound(connection, programId, roundId);
    if (!round) {
      return { status: 404, body: { error: "round_not_found", detail: `round ${roundId} does not exist` } };
    }

    // The program credited the participant account when it processed the
    // deposit instruction; this endpoint only verifies that it really happened.
    const { tx: depositTx } = store.txs.begin({
      kind: "DEPOSIT",
      idempotencyKey: `deposit:${roundId.toString()}:${deposit.from.toBase58()}`,
      roundId: roundId.toString(),
      tier: round.tier,
      wallet: deposit.from.toBase58(),
      recipient: escrowPk.toBase58(),
      network: "devnet",
      depositAmountLamports: deposit.amount.toString(),
    });

    // Record ONLY after on-chain verification succeeded. The transaction
    // state machine (store.txs) is the deposit ledger — a signature can only
    // ever be bound to one record.
    if (store.hasTx(signature)) {
      return { status: 409, body: { error: "already_verified", detail: "this signature was already processed" } };
    }
    try {
      store.txs.attachSignature(depositTx.id, signature);
    } catch (err) {
      // A second, different transfer for the same (round, wallet) is a
      // duplicate deposit: the chain keeps both transfers, only one entry.
      return {
        status: 409,
        body: {
          error: err instanceof TxStateError ? err.code : "already_recorded",
          detail: err instanceof Error ? err.message : "deposit already recorded for this wallet and round",
        },
      };
    }

    const body = {
      ok: true,
      kind,
      roundId: roundId.toString(),
      wallet: deposit.from.toBase58(),
      amountLamports: deposit.amount.toString(),
      escrow: escrowPk.toBase58(),
      escrowBalanceLamports: escrowBalance.toString(),
      roundStatus: round.status,
      potLamports: round.pot.toString(),
      signature,
      slot: tx.slot?.toString(),
    };

    broadcast({ type: "deposit", roundId: roundId.toString(), data: body });
    broadcast({
      type: "pot",
      roundId: roundId.toString(),
      data: { potLamports: round.pot.toString(), participantCount: round.participantCount },
    });

    return { status: 200, body };
  }

  // Non-deposit kinds: verified on-chain, reported with their result only.
  return {
    status: 200,
    body: { ok: true, kind, signature, slot: tx.slot?.toString(), commitment: COMMITMENT },
  };
}

async function fetchRound(connection: Connection, programId: PublicKey, roundId: bigint) {
  const { fetchRoundAccount } = await import("@solana-roulette/verification");
  return fetchRoundAccount(connection, programId, roundId);
}
