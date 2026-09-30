/**
 * Transaction state machine — the single source of truth for money.
 *
 *   PENDING ──▶ CONFIRMED
 *   PENDING ──▶ FAILED
 *
 * CONFIRMED and FAILED are terminal. There is no "credited first, transfer
 * later": a round only ever receives a deposit after a CONFIRMED deposit, and
 * a payout is only ever marked COMPLETED after a CONFIRMED payout.
 *
 * Every record carries an `idempotencyKey` (unique) and, once submitted, a
 * transaction `signature` (unique). Those two constraints are what prevent
 * double deposits, duplicate payouts, double spending and re-processing after
 * a page refresh. The same rows are mirrored into PostgreSQL with unique
 * indexes, so the guarantee survives a restart and is enforced by the database
 * as well as by this process.
 */
import { randomUUID } from "node:crypto";
import { txLog } from "./logger.js";
import { DEVNET_EXPLORER_TX } from "./custody.js";

export type TxKind = "DEPOSIT" | "PAYOUT";
export type TxStatus = "PENDING" | "CONFIRMED" | "FAILED";

export interface ChainTx {
  id: string;
  idempotencyKey: string;
  kind: TxKind;
  roundId: string;
  tier: number;
  /** Player wallet for a DEPOSIT, winner wallet for a PAYOUT. */
  wallet: string;
  /** Escrow for a DEPOSIT, winner wallet for a PAYOUT. */
  recipient: string;
  network: string;
  /** Lamports the player sent (DEPOSIT). */
  depositAmountLamports: string | null;
  /**
   * The on-chain signature. Historical field name: it is written for BOTH
   * kinds (it is also the payout's signature) and every read path — the resume
   * logic, the DTO, the explorer link — depends on that. `payoutSignature`
   * mirrors the same value for PAYOUT rows so the database audit columns are
   * never null for a paid winner.
   */
  depositSignature: string | null;
  depositStatus: TxStatus | null;
  /** Lamports the winner receives (PAYOUT). */
  payoutAmountLamports: string | null;
  payoutSignature: string | null;
  payoutStatus: TxStatus | null;
  feeLamports: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  confirmedAt: Date | null;
  /** Backoff gate for automatic retries of a FAILED payout. */
  nextRetryAt: Date | null;
}

export interface BeginTxInput {
  kind: TxKind;
  idempotencyKey: string;
  roundId: string;
  tier: number;
  wallet: string;
  recipient: string;
  network: string;
  depositAmountLamports?: string;
  payoutAmountLamports?: string;
  feeLamports?: string;
}

export class TxStateError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TxStateError";
  }
}

export interface TxMirror {
  upsert(row: ChainTx): void;
}

export class TxLedger {
  private readonly byId = new Map<string, ChainTx>();
  private readonly idByKey = new Map<string, string>();
  private readonly idBySignature = new Map<string, string>();

  constructor(private readonly mirror?: TxMirror) {}

  // ------------------------------------------------------------------
  // lifecycle
  // ------------------------------------------------------------------

  /**
   * Create a PENDING record, or return the existing one for the same
   * idempotency key (a refresh / double click resumes instead of duplicating).
   */
  begin(input: BeginTxInput): { tx: ChainTx; created: boolean } {
    const existingId = this.idByKey.get(input.idempotencyKey);
    if (existingId) {
      return { tx: this.clone(this.byId.get(existingId)!), created: false };
    }
    const now = new Date();
    const tx: ChainTx = {
      id: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      kind: input.kind,
      roundId: input.roundId,
      tier: input.tier,
      wallet: input.wallet,
      recipient: input.recipient,
      network: input.network,
      depositAmountLamports: input.depositAmountLamports ?? null,
      depositSignature: null,
      depositStatus: "PENDING",
      payoutAmountLamports: input.payoutAmountLamports ?? null,
      payoutSignature: null,
      payoutStatus: input.kind === "PAYOUT" ? "PENDING" : null,
      feeLamports: input.feeLamports ?? null,
      attempts: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      confirmedAt: null,
      nextRetryAt: null,
    };
    this.byId.set(tx.id, tx);
    this.idByKey.set(tx.idempotencyKey, tx.id);
    this.persist(tx);
    txLog.info("tx.pending", {
      kind: tx.kind,
      id: tx.id,
      idempotencyKey: tx.idempotencyKey,
      roundId: tx.roundId,
      tier: tx.tier,
      wallet: tx.wallet,
      recipient: tx.recipient,
      network: tx.network,
      amountLamports: tx.kind === "DEPOSIT" ? tx.depositAmountLamports : tx.payoutAmountLamports,
      feeLamports: tx.feeLamports,
    });
    return { tx: this.clone(tx), created: true };
  }

  /**
   * Bind the on-chain signature to a PENDING record. A signature can only ever
   * belong to one record — replaying another deposit's signature is rejected.
   */
  attachSignature(id: string, signature: string): ChainTx {
    const tx = this.require(id);
    const owner = this.idBySignature.get(signature);
    if (owner && owner !== id) {
      throw new TxStateError("signature_reused", `signature already recorded on tx ${owner}`);
    }
    if (tx.depositSignature && tx.depositSignature !== signature) {
      throw new TxStateError("signature_conflict", "tx already carries a different signature");
    }
    this.idBySignature.set(signature, id);
    this.writeSignature(tx, signature);
    tx.updatedAt = new Date();
    this.persist(tx);
    txLog.info("tx.submitted", {
      kind: tx.kind,
      id: tx.id,
      roundId: tx.roundId,
      wallet: tx.wallet,
      amountLamports: tx.kind === "DEPOSIT" ? tx.depositAmountLamports : tx.payoutAmountLamports,
      network: tx.network,
      signature,
      explorer: DEVNET_EXPLORER_TX(signature),
    });
    return this.clone(tx);
  }

  /**
   * PENDING → CONFIRMED | FAILED. Terminal states never move again, so a
   * late-arriving "failed" callback can never un-credit a confirmed deposit or
   * un-pay a paid winner.
   */
  settle(
    id: string,
    status: Extract<TxStatus, "CONFIRMED" | "FAILED">,
    details: { signature?: string | null; error?: string | null; confirmedAt?: Date } = {}
  ): ChainTx {
    const tx = this.require(id);
    if (status !== "CONFIRMED" && status !== "FAILED") {
      throw new TxStateError("invalid_status", `cannot settle into ${status}`);
    }
    const field = tx.kind === "DEPOSIT" ? "depositStatus" : "payoutStatus";

    if (tx[field] === "CONFIRMED") {
      // CONFIRMED is terminal: a late "failed" must never un-credit money.
      if (status === "FAILED") {
        throw new TxStateError("already_confirmed", "tx is already CONFIRMED and cannot be failed");
      }
      // Idempotent replay: a second confirm of the same signature is a no-op.
      if (details.signature && details.signature !== tx.depositSignature) {
        throw new TxStateError("signature_conflict", "tx is already confirmed with another signature");
      }
      return this.clone(tx);
    }
    if (tx[field] === "FAILED") {
      throw new TxStateError("already_failed", "tx is already FAILED and cannot be revived");
    }

    if (status === "CONFIRMED") {
      if (details.signature) {
        const owner = this.idBySignature.get(details.signature);
        if (owner && owner !== id) {
          throw new TxStateError("signature_reused", `signature already recorded on tx ${owner}`);
        }
        this.idBySignature.set(details.signature, id);
      }
    }

    tx[field] = status;
    tx.updatedAt = new Date();
    tx.attempts += 1;
    if (details.signature) this.writeSignature(tx, details.signature);
    if (status === "CONFIRMED") {
      tx.confirmedAt = details.confirmedAt ?? new Date();
      tx.lastError = null;
      tx.nextRetryAt = null;
    } else {
      tx.lastError = details.error ?? "failed";
      tx.nextRetryAt = nextRetryAt(tx.attempts);
    }
    this.persist(tx);
    txLog[status === "CONFIRMED" ? "info" : "warn"](
      status === "CONFIRMED" ? "tx.confirmed" : "tx.failed",
      {
        kind: tx.kind,
        id: tx.id,
        roundId: tx.roundId,
        wallet: tx.wallet,
        recipient: tx.recipient,
        network: tx.network,
        amountLamports: tx.kind === "DEPOSIT" ? tx.depositAmountLamports : tx.payoutAmountLamports,
        feeLamports: tx.feeLamports,
        signature: tx.depositSignature,
        status,
        attempts: tx.attempts,
        error: tx.lastError,
      }
    );
    return this.clone(tx);
  }

  /** Mark a PENDING record FAILED when the player never submitted (rejected). */
  failPending(id: string, error: string): ChainTx {
    return this.settle(id, "FAILED", { error });
  }

  /**
   * CONFIRM a deposit whose transfer is PROVEN to have arrived while the record
   * was already FAILED.
   *
   * The one direction the terminal rule has to yield. A cancel (the player
   * closed the wallet, the client timed out) or the expiry reaper can mark a
   * deposit FAILED while a confirmation is still reading the chain; if the money
   * is then verified on chain and the round credits it, refusing to record that
   * would leave the pot credited while the ledger says FAILED — and the payout
   * is computed from CONFIRMED deposits only, so the winner would be paid short
   * and the difference would sit unexplained in the escrow.
   *
   * Only the deposit confirmation path may call this, and only after the chain
   * verified the transfer and the runtime accepted the credit. It never moves
   * money and never runs for payouts.
   */
  confirmProvenArrival(id: string, details: { signature: string; confirmedAt?: Date }): ChainTx {
    const tx = this.require(id);
    if (tx.depositStatus === "CONFIRMED") {
      if (tx.depositSignature && tx.depositSignature !== details.signature) {
        throw new TxStateError("signature_conflict", "tx is already confirmed with another signature");
      }
      return this.clone(tx);
    }
    const owner = this.idBySignature.get(details.signature);
    if (owner && owner !== id) {
      throw new TxStateError("signature_reused", `signature already recorded on tx ${owner}`);
    }
    this.idBySignature.set(details.signature, id);
    tx.depositStatus = "CONFIRMED";
    this.writeSignature(tx, details.signature);
    tx.confirmedAt = details.confirmedAt ?? new Date();
    tx.lastError = null;
    tx.nextRetryAt = null;
    tx.updatedAt = new Date();
    this.persist(tx);
    txLog.info("tx.confirmed_after_late_fail", {
      kind: tx.kind,
      id: tx.id,
      roundId: tx.roundId,
      wallet: tx.wallet,
      network: tx.network,
      amountLamports: tx.depositAmountLamports,
      signature: tx.depositSignature,
      status: "CONFIRMED",
      attempts: tx.attempts,
    });
    return this.clone(tx);
  }

  // ------------------------------------------------------------------
  // queries
  // ------------------------------------------------------------------

  /**
   * Re-admit records read back from the audit mirror after a restart.
   *
   * The indexes above are what make idempotence hold: the idempotency key, the
   * signature and the confirmed-deposit/confirmed-payout gates. They live in
   * memory, and the mirror is written through on every state change, so a
   * restart would otherwise come up with an EMPTY ledger — no "already
   * deposited?" gate, no spent-signature guard, no "already paid?" guard — and
   * the same on-chain transfer could be presented again as a fresh deposit.
   *
   * A record already in memory always wins, and a row whose signature is
   * already owned by an in-memory record is skipped: restoring must never
   * weaken a guard that is live right now. Nothing is re-mirrored — these rows
   * were just read from the mirror.
   */
  restore(rows: ChainTx[]): number {
    let restored = 0;
    for (const row of rows) {
      if (!row || typeof row.id !== "string" || row.id === "") continue;
      if (typeof row.idempotencyKey !== "string" || row.idempotencyKey === "") continue;
      if (this.byId.has(row.id)) continue;
      if (row.depositSignature) {
        const owner = this.idBySignature.get(row.depositSignature);
        if (owner && owner !== row.id) continue;
        this.idBySignature.set(row.depositSignature, row.id);
      }
      this.byId.set(row.id, { ...row });
      this.idByKey.set(row.idempotencyKey, row.id);
      restored += 1;
    }
    return restored;
  }

  get(id: string): ChainTx | null {
    const tx = this.byId.get(id);
    return tx ? this.clone(tx) : null;
  }

  bySignature(signature: string): ChainTx | null {
    const id = this.idBySignature.get(signature);
    return id ? this.get(id) : null;
  }

  /** Any record for this idempotency key (CONFIRMED, FAILED or PENDING). */
  find(input: { kind: TxKind; roundId: string; wallet: string }): ChainTx | null {
    const key = depositKey(input.roundId, input.wallet);
    const id = this.idByKey.get(key);
    return id ? this.get(id) : null;
  }

  getDeposit(roundId: string | bigint, wallet: string): ChainTx | null {
    const id = roundId.toString();
    let latest: ChainTx | null = null;
    for (const tx of this.byId.values()) {
      if (tx.kind !== "DEPOSIT" || tx.roundId !== id || tx.wallet !== wallet) continue;
      if (!latest || tx.createdAt.getTime() >= latest.createdAt.getTime()) latest = tx;
    }
    return latest ? this.clone(latest) : null;
  }

  /**
   * A CONFIRMED deposit for this wallet in this round — the credit gate. It
   * scans every attempt on purpose: a retry after a failed transfer must never
   * slip past the "one entry per wallet per round" rule.
   */
  getConfirmedDeposit(roundId: string | bigint, wallet: string): ChainTx | null {
    const id = roundId.toString();
    for (const tx of this.byId.values()) {
      if (tx.kind !== "DEPOSIT" || tx.roundId !== id || tx.wallet !== wallet) continue;
      if (tx.depositStatus === "CONFIRMED") return this.clone(tx);
    }
    return null;
  }

  getPayout(roundId: string | bigint, attempt?: number): ChainTx | null {
    if (attempt !== undefined) {
      const id = this.idByKey.get(payoutKey(roundId.toString(), attempt));
      return id ? this.get(id) : null;
    }
    return this.latestPayout(roundId);
  }

  /** Most recent payout record for a round, whatever its status. */
  latestPayout(roundId: string | bigint): ChainTx | null {
    const id = roundId.toString();
    let latest: ChainTx | null = null;
    for (const tx of this.byId.values()) {
      if (tx.kind !== "PAYOUT" || tx.roundId !== id) continue;
      if (!latest || tx.createdAt.getTime() >= latest.createdAt.getTime()) latest = tx;
    }
    return latest ? this.clone(latest) : null;
  }

  /** Number of payout attempts already made for a round. */
  payoutAttempts(roundId: string | bigint): number {
    return this.latestPayout(roundId)?.attempts ?? 0;
  }

  /** CONFIRMED payout for the round — the single-payout guard. */
  getConfirmedPayout(roundId: string | bigint): ChainTx | null {
    for (const tx of this.byId.values()) {
      if (tx.kind !== "PAYOUT" || tx.roundId !== roundId.toString()) continue;
      if (tx.payoutStatus === "CONFIRMED") return this.clone(tx);
    }
    return null;
  }

  /** Pot backed by CONFIRMED deposits only. Never by PENDING or FAILED rows. */
  confirmedPotLamports(roundId: string | bigint): bigint {
    let total = 0n;
    for (const tx of this.byId.values()) {
      if (tx.kind !== "DEPOSIT") continue;
      if (tx.roundId !== roundId.toString()) continue;
      if (tx.depositStatus !== "CONFIRMED") continue;
      total += BigInt(tx.depositAmountLamports ?? "0");
    }
    return total;
  }

  listByRound(roundId: string | bigint): ChainTx[] {
    const id = roundId.toString();
    return [...this.byId.values()]
      .filter((t) => t.roundId === id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((t) => this.clone(t));
  }

  /** Newest first, optionally narrowed by kind and state (admin console). */
  listRecent(filter: { kind?: TxKind; status?: TxStatus; limit?: number } = {}): ChainTx[] {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const rows = [...this.byId.values()]
      .filter((t) => (filter.kind ? t.kind === filter.kind : true))
      .filter((t) => {
        if (!filter.status) return true;
        return (t.kind === "DEPOSIT" ? t.depositStatus : t.payoutStatus) === filter.status;
      })
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit)
      .map((t) => this.clone(t));
    return rows;
  }

  /** Totals per kind × state for the admin dashboard tiles. */
  counts(): { deposits: Record<string, number>; payouts: Record<string, number>; total: number } {
    const deposits: Record<string, number> = { PENDING: 0, CONFIRMED: 0, FAILED: 0 };
    const payouts: Record<string, number> = { PENDING: 0, CONFIRMED: 0, FAILED: 0 };
    let total = 0;
    for (const t of this.byId.values()) {
      total++;
      const bucket = t.kind === "DEPOSIT" ? deposits : payouts;
      const status = t.kind === "DEPOSIT" ? t.depositStatus : t.payoutStatus;
      if (status && status in bucket) bucket[status] += 1;
    }
    return { deposits, payouts, total };
  }

  /** PENDING records older than `ageMs` — the reconciler's work queue. */
  listStalePending(ageMs: number): ChainTx[] {
    const cutoff = Date.now() - ageMs;
    return [...this.byId.values()]
      .filter((t) => t.depositStatus === "PENDING" && t.createdAt.getTime() <= cutoff)
      .map((t) => this.clone(t));
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  /**
   * Bind an on-chain signature to a record. `depositSignature` is the
   * historical field every read path uses, so it is written for both kinds and
   * `payoutSignature` is filled in for PAYOUT rows (the mirror's
   * `payout_signature` column must never be null for a confirmed payout).
   */
  private writeSignature(tx: ChainTx, signature: string): void {
    tx.depositSignature = signature;
    if (tx.kind === "PAYOUT") tx.payoutSignature = signature;
  }

  private require(id: string): ChainTx {
    const tx = this.byId.get(id);
    if (!tx) throw new TxStateError("tx_not_found", `no transaction with id ${id}`);
    return tx;
  }

  private clone(tx: ChainTx): ChainTx {
    return { ...tx };
  }

  private persist(tx: ChainTx): void {
    try {
      this.mirror?.upsert(this.clone(tx));
    } catch (err) {
      // The chain stays authoritative: a mirror failure must never block money.
      txLog.warn("tx.mirror_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** One deposit per wallet per round — the anti-double-deposit key. */
export function depositKey(roundId: string | bigint, wallet: string, attempt = 1): string {
  const base = `deposit:${roundId.toString()}:${wallet}`;
  return attempt > 1 ? `${base}:${attempt}` : base;
}

/**
 * Attempt number encoded in a deposit record's idempotency key. Attempt 1 keeps
 * the historical key, so existing mirror rows keep resolving.
 */
export function depositAttemptOf(tx: ChainTx): number {
  const parts = tx.idempotencyKey.split(":");
  if (parts.length < 4) return 1;
  const tail = Number(parts[parts.length - 1]);
  return Number.isInteger(tail) && tail > 1 ? tail : 1;
}

/**
 * One payout ATTEMPT per round — the anti-duplicate-payout key. A retry after
 * a definitively failed attempt gets the next attempt number; the CONFIRMED
 * guard (getConfirmedPayout) is what actually prevents a second payment.
 */
export function payoutKey(roundId: string | bigint, attempt: number): string {
  return `payout:${roundId.toString()}:${attempt}`;
}

/** Attempt number encoded in a payout record's idempotency key. */
export function payoutAttemptOf(tx: ChainTx): number {
  const tail = Number(tx.idempotencyKey.split(":").pop());
  return Number.isInteger(tail) && tail > 0 ? tail : 1;
}

/** 15s, 30s, 60s, 120s, capped at 5 minutes. */
export function nextRetryAt(attempts: number): Date {
  const seconds = Math.min(300, 15 * 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + seconds * 1000);
}

/** API-safe projection (no internal fields, no secrets). */
export function txToDto(tx: ChainTx): Record<string, unknown> {
  const status = tx.kind === "DEPOSIT" ? tx.depositStatus : tx.payoutStatus;
  return {
    id: tx.id,
    kind: tx.kind,
    status,
    roundId: tx.roundId,
    tier: tx.tier,
    network: tx.network,
    wallet: tx.wallet,
    recipient: tx.recipient,
    amountLamports: tx.kind === "DEPOSIT" ? tx.depositAmountLamports : tx.payoutAmountLamports,
    feeLamports: tx.feeLamports,
    signature: tx.depositSignature,
    explorer: tx.depositSignature ? DEVNET_EXPLORER_TX(tx.depositSignature) : null,
    error: tx.lastError,
    attempts: tx.attempts,
    createdAt: tx.createdAt.toISOString(),
    updatedAt: tx.updatedAt.toISOString(),
    confirmedAt: tx.confirmedAt?.toISOString() ?? null,
  };
}
