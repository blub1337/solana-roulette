/**
 * Audit/index layer. The Solana chain is the source of truth for money.
 * PostgreSQL (when DATABASE_URL is set) receives a write-through mirror of
 * every transaction state change; the in-memory index serves the API hot path.
 *
 * Money state lives in the transaction state machine (txLedger.ts):
 * PENDING → CONFIRMED | FAILED. `hasPayout` is consulted BEFORE any on-chain
 * payout is attempted, and a round is only marked COMPLETED after its payout
 * is CONFIRMED (docs/PAYMENTS.md §idempotence).
 */
import { createHash } from "node:crypto";
import { TIER_COUNT, type RoundSummary, type SseEvent } from "@solana-roulette/types";
import { TxLedger, type ChainTx } from "./txLedger.js";

export interface StoreRound {
  id: string;
  /** Pool lane (0=1 SOL, 1=10 SOL, 2=100 SOL). */
  tier: number;
  status: string;
  pot: string;
  feeBps: number;
  winner: string | null;
  payoutTxSignature: string | null;
  feeTxSignature: string | null;
  settlementVerified: boolean;
  completedAt: Date | null;
}

export class Store {
  private listeners = new Set<(e: SseEvent) => void>();
  private rounds = new Map<string, StoreRound>();
  private payouts = new Set<string>();
  private seq = 0;

  /**
   * Transaction state machine. PENDING → CONFIRMED | FAILED, with unique
   * idempotency keys and signatures. This is what a round's pot is built from.
   */
  readonly txs = new TxLedger({ upsert: (tx) => postgresMirror.upsertChainTx(tx) });

  /**
   * Head round id per tier lane. Round ids are globally sequential (the
   * program's shared counter), so lanes start at 1, 2, 3 — the first rounds
   * of tier 0/1/2 respectively. Each lane advances INDEPENDENTLY: a full
   * 1-SOL round never blocks or influences the 10/100-SOL lanes.
   */
  currentRoundIdByTier: bigint[] = Array.from({ length: TIER_COUNT }, (_, t) => BigInt(t + 1));

  // ------------------------------------------------------------------
  // SSE fan-out
  // ------------------------------------------------------------------

  addListener(fn: (e: SseEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  broadcast(ev: Omit<SseEvent, "ts"> & { ts?: number }): void {
    const event: SseEvent = { ...ev, ts: ev.ts ?? Date.now() } as SseEvent;
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch (err) {
        console.error("[store] listener error", err);
      }
    }
    this.seq++;
  }

  // ------------------------------------------------------------------
  // Tx ledger (idempotence)
  // ------------------------------------------------------------------

  /** True when the signature is already bound to a transaction record. */
  hasTx(signature: string): boolean {
    return this.txs.bySignature(signature) !== null;
  }

  /**
   * Primary payout guard: a CONFIRMED payout record for the round. The
   * in-memory set is the secondary guard for the program-paid path.
   */
  hasPayout(roundId: string): boolean {
    return this.payouts.has(roundId) || this.txs.getConfirmedPayout(roundId) !== null;
  }

  markPayout(roundId: string): void {
    this.payouts.add(roundId);
  }

  /** Every transaction of a round, oldest first (deposits and payout). */
  listTxsByRound(roundId: bigint): ChainTx[] {
    return this.txs.listByRound(roundId);
  }

  // ------------------------------------------------------------------
  // Rounds (audit mirror of chain state)
  // ------------------------------------------------------------------

  upsertRound(r: Partial<StoreRound> & { id: string }): void {
    const existing = this.rounds.get(r.id);
    this.rounds.set(r.id, {
      id: r.id,
      tier: r.tier ?? existing?.tier ?? 0,
      status: r.status ?? existing?.status ?? "OPEN",
      pot: r.pot ?? existing?.pot ?? "0",
      feeBps: r.feeBps ?? existing?.feeBps ?? 750,
      winner: r.winner ?? existing?.winner ?? null,
      payoutTxSignature: r.payoutTxSignature ?? existing?.payoutTxSignature ?? null,
      feeTxSignature: r.feeTxSignature ?? existing?.feeTxSignature ?? null,
      settlementVerified: r.settlementVerified ?? existing?.settlementVerified ?? false,
      completedAt: r.completedAt ?? existing?.completedAt ?? null,
    });
  }

  getRound(id: string): StoreRound | undefined {
    const r = this.rounds.get(id);
    return r ? { ...r } : undefined;
  }

  listCompletedRounds(): StoreRound[] {
    return [...this.rounds.values()]
      .filter((r) => r.status === "COMPLETED" || r.status === "CANCELLED")
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .map((r) => ({ ...r }));
  }

  upsertRoundMirror(round: RoundSummary): void {
    void postgresMirror.enqueue({
      table: "rounds",
      op: "upsert-by-chain-id",
      row: {
        chainId: round.id,
        status: round.status,
        pot: round.potLamports,
        feeBps: round.feeBps,
        winner: round.winner ?? null,
        payoutLamports: round.payoutLamports ?? null,
        feeLamports: round.feeLamports ?? null,
      },
      dedupeKey: sha256(`round:${round.id}:${round.status}:${round.potLamports}`),
    });
  }

  mirrorFailure(scope: string, error: string): void {
    void postgresMirror.enqueue({
      table: "failures",
      op: "insert",
      row: { scope, error, at: new Date().toISOString() },
      dedupeKey: sha256(`fail:${scope}:${error}:${Math.floor(Date.now() / 60_000)}`),
    });
  }

  async close(): Promise<void> {
    await postgresMirror.close();
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL write-through mirror (docs/DATABASE.md)
// ---------------------------------------------------------------------------

/**
 * Minimal write-through queue to Postgres when DATABASE_URL is set.
 * Fire-and-forget with backpressure cap: the chain stays authoritative; the
 * mirror is an audit convenience. Failures are logged, never thrown.
 */
export class PostgresMirror {
  private queue: unknown[] = [];
  private timer: NodeJS.Timeout | null = null;
  private client: { query: (sql: string, params?: unknown[]) => Promise<unknown> } | null = null;
  private connecting: Promise<{ query: (sql: string, params?: unknown[]) => Promise<unknown> }> | null = null;

  constructor(private readonly databaseUrl: string | undefined) {}

  /**
   * Write-through of the transaction state machine. One row per transaction
   * with the full lifecycle (player wallet, amounts, signatures, statuses,
   * timestamps) so the database can be reconciled against the chain.
   */
  upsertChainTx(tx: ChainTx): void {
    this.enqueue({
      table: "chain_transactions",
      op: "upsert-by-id",
      row: {
        id: tx.id,
        idempotencyKey: tx.idempotencyKey,
        kind: tx.kind,
        roundId: tx.roundId,
        tier: tx.tier,
        playerWallet: tx.wallet,
        recipientWallet: tx.recipient,
        network: tx.network,
        depositAmountLamports: tx.depositAmountLamports,
        depositSignature: tx.depositSignature,
        depositStatus: tx.depositStatus,
        payoutAmountLamports: tx.payoutAmountLamports,
        payoutSignature: tx.payoutSignature,
        payoutStatus: tx.payoutStatus,
        feeLamports: tx.feeLamports,
        attempts: tx.attempts,
        error: tx.lastError,
        createdAt: tx.createdAt.toISOString(),
        updatedAt: tx.updatedAt.toISOString(),
        confirmedAt: tx.confirmedAt ? tx.confirmedAt.toISOString() : null,
      },
      dedupeKey: sha256(`chaintx:${tx.id}:${tx.depositStatus}:${tx.payoutStatus}:${tx.updatedAt.getTime()}`),
    });
  }

  enqueue(job: { table: string; op: string; row: Record<string, unknown>; dedupeKey: string }): void {
    if (!this.databaseUrl) return;
    this.queue.push(job);
    if (this.queue.length > 5000) this.queue.splice(0, this.queue.length - 5000);
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), 500);
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> {
    this.timer = null;
    if (this.queue.length === 0) return;
    const jobs = this.queue.splice(0, this.queue.length);
    try {
      const client = await this.getClient();
      for (const job of jobs) {
        const j = job as { table: string; op: string; row: Record<string, unknown>; dedupeKey: string };
        if (j.table === "chain_transactions") {
          await client.query(
            `INSERT INTO chain_transactions (
               id, idempotency_key, kind, round_id, tier, player_wallet, recipient_wallet,
               network, deposit_amount_lamports, deposit_signature, deposit_status,
               payout_amount_lamports, payout_signature, payout_status, fee_lamports,
               attempts, error, created_at, updated_at, confirmed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
             ON CONFLICT (id) DO UPDATE SET
               deposit_amount_lamports = EXCLUDED.deposit_amount_lamports,
               deposit_signature = EXCLUDED.deposit_signature,
               deposit_status = EXCLUDED.deposit_status,
               payout_amount_lamports = EXCLUDED.payout_amount_lamports,
               payout_signature = EXCLUDED.payout_signature,
               payout_status = EXCLUDED.payout_status,
               fee_lamports = EXCLUDED.fee_lamports,
               attempts = EXCLUDED.attempts,
               error = EXCLUDED.error,
               updated_at = EXCLUDED.updated_at,
               confirmed_at = EXCLUDED.confirmed_at`,
            [
              j.row.id, j.row.idempotencyKey, j.row.kind, j.row.roundId, j.row.tier,
              j.row.playerWallet, j.row.recipientWallet, j.row.network,
              j.row.depositAmountLamports, j.row.depositSignature, j.row.depositStatus,
              j.row.payoutAmountLamports, j.row.payoutSignature, j.row.payoutStatus,
              j.row.feeLamports, j.row.attempts, j.row.error, j.row.createdAt,
              j.row.updatedAt, j.row.confirmedAt,
            ]
          );
        } else if (j.table === "rounds") {
          await client.query(
            `INSERT INTO rounds (chain_id, status, pot, fee_bps, winner, payout_lamports, fee_lamports, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7, now())
             ON CONFLICT (chain_id) DO UPDATE SET
               status = EXCLUDED.status, pot = EXCLUDED.pot, fee_bps = EXCLUDED.fee_bps,
               winner = EXCLUDED.winner, payout_lamports = EXCLUDED.payout_lamports,
               fee_lamports = EXCLUDED.fee_lamports, updated_at = now()`,
            [j.row.chainId, j.row.status, j.row.pot, j.row.feeBps, j.row.winner, j.row.payoutLamports, j.row.feeLamports]
          );
        } else if (j.table === "failures") {
          await client.query(
            `INSERT INTO failures (scope, error, at) VALUES ($1,$2,$3)`,
            [j.row.scope, j.row.error, j.row.at]
          );
        } else if (j.table === "admin_state") {
          await client.query(
            `INSERT INTO admin_state (id, deposits, updated_at)
             VALUES ('global', $1, now())
             ON CONFLICT (id) DO UPDATE SET deposits = EXCLUDED.deposits, updated_at = now()`,
            [j.row.deposits]
          );
        }
      }
    } catch (err) {
      console.warn("[mirror] postgres write failed:", err instanceof Error ? err.message : err);
    }
  }

  private async getClient() {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const url = this.databaseUrl!;
      if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
        // Lazy, optional dependency: without DATABASE_URL the mirror is inert.
        const pg = (await import(/* webpackIgnore: true */ "pg")) as unknown as {
          Client: new (opts: { connectionString: string }) => {
            connect: () => Promise<void>;
            query: (sql: string, params?: unknown[]) => Promise<unknown>;
          };
        };
        const c = new pg.Client({ connectionString: url });
        await c.connect();
        // Self-provision the audit-mirror tables (idempotent). The mirror is
        // never authoritative and never blocks the API on failure.
        await c.query(`CREATE TABLE IF NOT EXISTS chain_transactions (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL,
          round_id TEXT NOT NULL,
          tier INTEGER NOT NULL DEFAULT 0,
          player_wallet TEXT NOT NULL,
          recipient_wallet TEXT NOT NULL,
          network TEXT NOT NULL DEFAULT 'devnet',
          deposit_amount_lamports TEXT,
          deposit_signature TEXT,
          deposit_status TEXT,
          payout_amount_lamports TEXT,
          payout_signature TEXT,
          payout_status TEXT,
          fee_lamports TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          confirmed_at TIMESTAMPTZ
        )`);
        // One signature per transaction, one CONFIRMED deposit per wallet per
        // round and one payout per round: the database refuses double spending
        // even if the process is restarted or two requests race. FAILED deposit
        // attempts may coexist — they carry no money and a player must be able
        // to retry after a failed transfer.
        await c.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS chain_transactions_deposit_sig
             ON chain_transactions (deposit_signature) WHERE deposit_signature IS NOT NULL`
        );
        await c.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS chain_transactions_payout_sig
             ON chain_transactions (payout_signature) WHERE payout_signature IS NOT NULL`
        );
        await c.query(`DROP INDEX IF EXISTS chain_transactions_deposit_per_wallet`);
        await c.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS chain_transactions_confirmed_deposit_per_wallet
             ON chain_transactions (round_id, player_wallet)
             WHERE kind = 'DEPOSIT' AND deposit_status = 'CONFIRMED'`
        );
        await c.query(`CREATE TABLE IF NOT EXISTS rounds (
          chain_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          pot TEXT,
          fee_bps INTEGER,
          winner TEXT,
          payout_lamports TEXT,
          fee_lamports TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
        await c.query(`CREATE TABLE IF NOT EXISTS failures (
          id BIGSERIAL PRIMARY KEY,
          scope TEXT NOT NULL,
          error TEXT NOT NULL,
          at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
        // Operator kill switch. Never a secret: ACTIVE/PAUSED only. A restart
        // must not silently re-enable deposits an operator switched off.
        await c.query(`CREATE TABLE IF NOT EXISTS admin_state (
          id TEXT PRIMARY KEY,
          deposits TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
        this.client = c;
      } else if (url.startsWith("prisma:")) {
        throw new PrismaProxyNotSupportedError();
      } else if (url.startsWith("file:")) {
        throw new PrismaProxyNotSupportedError();
      } else {
        throw new PrismaProxyNotSupportedError();
      }
      return this.client!;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  /** Persist the operator kill switch (ACTIVE | PAUSED). */
  upsertAdminState(deposits: string): void {
    this.enqueue({
      table: "admin_state",
      op: "upsert",
      row: { deposits },
      dedupeKey: sha256(`admin_state:${deposits}`),
    });
  }

  /**
   * Read the persisted kill switch back at boot. Returns null when no
   * `DATABASE_URL` is configured or the row has never been written. Callers
   * must treat a failure as "no opinion", never as "resume".
   */
  async readAdminState(): Promise<string | null> {
    if (!this.databaseUrl || !this.databaseUrl.startsWith("postgres")) return null;
    const client = (await this.getClient()) as {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
    };
    const res = await client.query(`SELECT deposits FROM admin_state WHERE id = 'global'`);
    const value = res.rows[0]?.deposits;
    return typeof value === "string" ? value : null;
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const c = this.client;
    this.client = null;
    if (c && typeof (c as { end?: unknown }).end === "function") {
      await (c as unknown as { end: () => Promise<void> }).end();
    }
  }
}

export class PrismaProxyNotSupportedError extends Error {
  constructor() {
    super("DATABASE_URL must be a direct postgres:// connection string for the audit mirror");
    this.name = "PrismaProxyNotSupportedError";
  }
}

export const postgresMirror = new PostgresMirror(process.env.DATABASE_URL);

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ---------------------------------------------------------------------------
// Singleton + SSE helper used by routes/settlement/verifyTx
// ---------------------------------------------------------------------------

export const store = new Store();

export function broadcast(ev: Omit<SseEvent, "ts"> & { ts?: number }): void {
  store.broadcast(ev);
}

export function addSseListener(fn: (e: SseEvent) => void): () => void {
  return store.addListener(fn);
}
