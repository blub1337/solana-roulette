/**
 * Single-writer guard for the settlement driver.
 *
 * The driver is unattended: every instance that boots in chain mode opens,
 * locks, settles and pays rounds. When two instances run against the SAME
 * program (e.g. a dev workspace plus a deployed service that share one program
 * and one operator key) their per-process lane heads drift apart. Each sees the
 * same terminal head and opens its own "next" round, so the shared on-chain
 * counter advances twice and one lane's round is orphaned: its escrow keeps the
 * rent-exempt lamports forever and `/api/pools` can point at a head nobody
 * settles.
 *
 * Leadership is a row in a small `settlement_driver_lease` table in the shared
 * audit database, claimed with a single atomic UPSERT. Every instance that
 * shares `DATABASE_URL` contends for the SAME row, so exactly one holds it. The
 * row carries an expiry: the holder renews it on every tick (heartbeat), and a
 * crashed holder's row simply expires, letting a standby take over.
 *
 * A lease TABLE (not a Postgres advisory lock) is deliberate: `DATABASE_URL`
 * typically points at a connection pooler (PgBouncer/Neon/Render pooled
 * endpoints), where session-scoped advisory locks do not survive between
 * statements. A conditional UPSERT is a single atomic statement, so it is
 * pooler-safe.
 *
 * Without `DATABASE_URL` (single-process dev, the local ledger, unit tests)
 * there is no shared resource to arbitrate, so the lease is a no-op that always
 * grants leadership: a lone process is trivially the only writer.
 */
import { randomUUID } from "node:crypto";
import { txLog } from "./logger.js";

export interface DriverLease {
  /** Which arbiter backs this lease (for logs and tests). */
  readonly kind: "postgres" | "none";
  /**
   * True while THIS instance may run the driver. Claims or renews the lease;
   * called every tick (it doubles as the heartbeat).
   */
  acquire(): Promise<boolean>;
  /** Give up leadership early (it would otherwise expire on its own). */
  release(): Promise<void>;
}

/** A lone writer — used when there is no shared database to arbitrate. */
export function alwaysLeaderLease(): DriverLease {
  return {
    kind: "none",
    async acquire() {
      return true;
    },
    async release() {
      /* nothing held */
    },
  };
}

/** Scope key for a program's driver — one writer per (network, program). */
export function driverLeaseScope(network: string, programId: string): string {
  return `roulette:settlement-driver:${network}:${programId}`;
}

interface LeaseConnection {
  query: (sql: string, params?: unknown[]) => Promise<{ rows?: { holder?: string }[] }>;
  on: (event: string, listener: (err: Error) => void) => void;
}

/** How long a claim stays valid without a heartbeat. Renewed every tick. */
function leaseTtlSeconds(): number {
  const n = Number(process.env.SETTLEMENT_LEASE_TTL_SECONDS ?? 60);
  return Number.isFinite(n) && n >= 10 ? n : 60;
}

/**
 * Lease-table implementation.
 *
 * `acquire()` is one atomic statement:
 *   INSERT ... ON CONFLICT (scope) DO UPDATE ... WHERE holder = me OR expired
 *   RETURNING holder
 * It returns the row only when THIS instance holds a live claim, so two
 * processes racing the same scope can never both proceed.
 */
export function createPostgresDriverLease(databaseUrl: string, scope: string): DriverLease {
  const holder = randomUUID();
  const ttl = leaseTtlSeconds();
  let client: LeaseConnection | null = null;
  let connecting: Promise<LeaseConnection> | null = null;
  let ready = false;

  const connect = async (): Promise<LeaseConnection> => {
    if (client) return client;
    if (connecting) return connecting;
    connecting = (async () => {
      // Lazy, optional dependency: only pulled in when a DATABASE_URL is set,
      // exactly like the audit mirror (see store.ts).
      const pg = (await import(/* webpackIgnore: true */ "pg")) as unknown as {
        Client: new (opts: { connectionString: string }) => LeaseConnection & {
          connect: () => Promise<void>;
        };
      };
      const c = new pg.Client({ connectionString: databaseUrl });
      c.on("error", (err) => {
        // Best-effort: log, drop the client, let the next acquire() reconnect.
        console.warn("[settlement-lease] connection lost (will reconnect):", err.message);
        client = null;
        ready = false;
      });
      await c.connect();
      client = c;
      return c;
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  };

  const ensure = async (): Promise<LeaseConnection> => {
    const c = await connect();
    if (!ready) {
      await c.query(
        `CREATE TABLE IF NOT EXISTS settlement_driver_lease (
           scope TEXT PRIMARY KEY,
           holder TEXT NOT NULL,
           expires_at TIMESTAMPTZ NOT NULL
         )`
      );
      ready = true;
    }
    return c;
  };

  return {
    kind: "postgres",
    async acquire() {
      try {
        const c = await ensure();
        const res = await c.query(
          `INSERT INTO settlement_driver_lease (scope, holder, expires_at)
           VALUES ($1, $2, now() + ($3::int * interval '1 second'))
           ON CONFLICT (scope) DO UPDATE
             SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
             WHERE settlement_driver_lease.holder = EXCLUDED.holder
                OR settlement_driver_lease.expires_at < now()
           RETURNING holder`,
          [scope, holder, ttl]
        );
        return res?.rows?.[0]?.holder === holder;
      } catch (err) {
        // A lease-backend hiccup must never silently grant leadership: stay a
        // standby and re-contend on the next tick. (Fail-closed: while the
        // arbitration backend is unavailable, no instance claims to be leader.)
        txLog.warn("settlement.lease_error", {
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },
    async release() {
      try {
        await client?.query("DELETE FROM settlement_driver_lease WHERE scope = $1 AND holder = $2", [
          scope,
          holder,
        ]);
      } catch {
        /* the claim expires on its own anyway */
      }
    },
  };
}

/**
 * Pick the lease for this process.
 *
 * Chain mode + a direct postgres `DATABASE_URL` → a shared lease row. Anything
 * else (local ledger, no database, unit tests) → always-leader: there is no
 * shared resource to arbitrate and a single process is trivially the only
 * writer.
 *
 * The test guard mirrors `PostgresMirror`: the workspace `.env` carries the
 * real DATABASE_URL into the test process, and tests must never open a
 * connection to (or write a lease into) the production audit database.
 */
export function createDriverLease(args: {
  databaseUrl: string | undefined;
  programId: string;
  network: string;
  mode: "chain" | "local";
}): DriverLease {
  const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
  if (isTest) return alwaysLeaderLease();
  if (args.mode !== "chain") return alwaysLeaderLease();
  const url = args.databaseUrl;
  if (!url || !/^postgres(ql)?:\/\//.test(url)) return alwaysLeaderLease();
  return createPostgresDriverLease(url, driverLeaseScope(args.network, args.programId));
}
