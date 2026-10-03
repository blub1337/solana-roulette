/**
 * Settlement-driver lease.
 *
 * The arbiter is a conditional UPSERT against a shared lease table, so the "pg"
 * module is mocked to model one shared table: two leases on the same scope must
 * not both hold it, renewal must keep a holder, and an expired claim must be
 * taken over by a standby. This is the property that stops a second deployment
 * from advancing the same program's lanes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("pg", () => {
  const table = new Map<string, { holder: string; expiresAt: number }>();
  class Client {
    constructor(_opts: unknown) {
      void _opts;
    }
    on(_event: string, _listener: (err: Error) => void): void {
      void _event;
      void _listener;
    }
    async connect(): Promise<void> {
      /* no socket in the mock */
    }
    async query(sql: string, params?: unknown[]) {
      if (sql.includes("CREATE TABLE")) return { rows: [] };
      if (sql.includes("INSERT INTO settlement_driver_lease")) {
        const [scope, holder, ttl] = params as [string, string, number];
        const row = table.get(scope);
        const now = Date.now();
        if (!row || row.holder === holder || row.expiresAt < now) {
          table.set(scope, { holder, expiresAt: now + Number(ttl) * 1000 });
          return { rows: [{ holder }] };
        }
        return { rows: [] };
      }
      if (sql.includes("DELETE FROM settlement_driver_lease")) {
        const [scope, holder] = params as [string, string];
        const row = table.get(scope);
        if (row && row.holder === holder) table.delete(scope);
        return { rows: [] };
      }
      return { rows: [] };
    }
  }
  return { Client, __table: table };
});

import * as pg from "pg";
import {
  alwaysLeaderLease,
  createDriverLease,
  createPostgresDriverLease,
  driverLeaseScope,
} from "./settlementLease.js";

const table = (pg as unknown as { __table: Map<string, { holder: string; expiresAt: number }> }).__table;
beforeEach(() => table.clear());

describe("driverLeaseScope", () => {
  it("is deterministic and scoped to network + program", () => {
    expect(driverLeaseScope("devnet", "ABC")).toBe(driverLeaseScope("devnet", "ABC"));
    expect(driverLeaseScope("devnet", "ABC")).not.toBe(driverLeaseScope("devnet", "XYZ"));
    expect(driverLeaseScope("devnet", "ABC")).not.toBe(driverLeaseScope("mainnet-beta", "ABC"));
  });
});

describe("postgres lease table", () => {
  const SCOPE = driverLeaseScope("devnet", "PROGRAM");

  it("grants leadership to exactly one contender for the same scope", async () => {
    const a = createPostgresDriverLease("postgres://db/x", SCOPE);
    const b = createPostgresDriverLease("postgres://db/x", SCOPE);
    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);
    expect(await b.acquire()).toBe(false); // still a standby
    expect(await a.acquire()).toBe(true); // the holder renews (heartbeat)
  });

  it("hands leadership over when the holder releases", async () => {
    const a = createPostgresDriverLease("postgres://db/x", SCOPE);
    const b = createPostgresDriverLease("postgres://db/x", SCOPE);
    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);
    await a.release();
    expect(await b.acquire()).toBe(true);
  });

  it("lets a standby take over once the holder's claim expires", async () => {
    const a = createPostgresDriverLease("postgres://db/x", SCOPE);
    const b = createPostgresDriverLease("postgres://db/x", SCOPE);
    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);

    // The holder died without releasing: its claim expires.
    table.set(SCOPE, { holder: "dead", expiresAt: Date.now() - 1 });

    expect(await b.acquire()).toBe(true);
    expect(await a.acquire()).toBe(false); // the old holder is now the standby
  });

  it("does not couple different programs (different scopes)", async () => {
    const a = createPostgresDriverLease("postgres://db/x", driverLeaseScope("devnet", "A"));
    const b = createPostgresDriverLease("postgres://db/x", driverLeaseScope("devnet", "B"));
    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(true);
  });
});

describe("lease selection", () => {
  it("alwaysLeaderLease grants unconditionally", async () => {
    const l = alwaysLeaderLease();
    expect(l.kind).toBe("none");
    expect(await l.acquire()).toBe(true);
    await l.release();
  });

  it("is a no-op (lone writer) for local mode", () => {
    expect(
      createDriverLease({ databaseUrl: "postgres://db/x", programId: "P", network: "devnet", mode: "local" }).kind
    ).toBe("none");
  });

  it("is a no-op without a postgres DATABASE_URL", () => {
    expect(
      createDriverLease({ databaseUrl: undefined, programId: "P", network: "devnet", mode: "chain" }).kind
    ).toBe("none");
    expect(
      createDriverLease({ databaseUrl: "mysql://x", programId: "P", network: "devnet", mode: "chain" }).kind
    ).toBe("none");
  });

  it("never opens the real audit database under test", () => {
    // The workspace .env carries a real DATABASE_URL into the test process; the
    // guard must keep the lease inert so tests never lock production.
    expect(
      createDriverLease({
        databaseUrl: "postgres://real-prod-db/x",
        programId: "P",
        network: "devnet",
        mode: "chain",
      }).kind
    ).toBe("none");
  });
});
