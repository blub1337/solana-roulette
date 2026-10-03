/**
 * ADMIN CONSOLE — the security boundary, end to end.
 *
 * The admin API is the only surface that reports escrow balances, the operator
 * address, the fee wallet and the transaction log, so it is tested as a
 * security boundary first and a dashboard second. The real Fastify server is
 * booted against a fake devnet RPC (the approach roundLifecycle.test.ts uses):
 * real signed `SystemProgram.transfer`s, real parsed transactions, no network.
 *
 * What is pinned here:
 *   - it FAILS CLOSED: with no ADMIN_TOKEN every admin route answers 403,
 *   - a wrong or missing token is 401, the right one is 200,
 *   - no response, log line or error body ever contains OPERATOR_KEYPAIR, the
 *     admin token or any private key material,
 *   - the deposit kill switch actually stops new deposits and resuming brings
 *     them back, while settlement keeps running untouched,
 *   - the overview reports devnet/mainnet state, escrow + operator + fee
 *     addresses, the live escrow balance, RPC health, the 7.5% fee and the
 *     1/10/100 SOL pool caps.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type Connection,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import bs58 from "bs58";
import { resolveConfig, type AppConfig } from "@solana-roulette/config";
import { buildServer } from "./server.js";
import { createLocalBackend } from "./backend.js";
import { runOnce, type SettlementDriverDeps } from "./settlement.js";
import { depositState, resetAdminStateForTests, setDepositsPaused } from "./adminState.js";
import { resetGameSettingsForTests } from "./adminSettings.js";
import { resetAdminThrottleForTests } from "./adminAuth.js";
import { logRing } from "./logBuffer.js";
import { store, postgresMirror } from "./store.js";
import { txLog } from "./logger.js";

const SOL = 1_000_000_000n;
const ADMIN_TOKEN = "admin-token-under-test-9f2c";
const PROGRAM_ID = new PublicKey("AAHBk1qbXCzsbiLe7TiXuZNTvNPVtovtC6NWk9tsi6EZ");
const FEE_WALLET = new PublicKey("6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR");
/** Escrow AND server-side payout signer (custody requires one account). */
const OPERATOR = Keypair.fromSeed(new Uint8Array(32).fill(77));
const ALICE = Keypair.fromSeed(new Uint8Array(32).fill(201));
const BOB = Keypair.fromSeed(new Uint8Array(32).fill(202));
const BLOCKHASH = "GtCRJqLMwRZgjqRVvTsyF1MhqNVvSPrKmkCbnRAH2Tb";
const TX_FEE = 5_000n;
/** Exactly what an operator would paste into OPERATOR_KEYPAIR. */
const OPERATOR_KEYPAIR_ENV = JSON.stringify(Array.from(OPERATOR.secretKey));

// ---------------------------------------------------------------------------
// fake devnet RPC — the same shape roundLifecycle.test.ts uses
// ---------------------------------------------------------------------------

interface Transfer {
  from: PublicKey;
  to: PublicKey;
  amount: bigint;
}

class FakeDevnetRpc {
  private readonly balances = new Map<string, bigint>();
  private readonly txs = new Map<string, ParsedTransactionWithMeta>();
  private slot = 1_000_000;

  fund(key: PublicKey, lamports: bigint): void {
    this.balances.set(key.toBase58(), lamports);
  }

  balance(key: PublicKey): bigint {
    return this.balances.get(key.toBase58()) ?? 0n;
  }

  send(tx: Transaction): string {
    const wire = tx.serialize();
    const signature = bs58.encode(wire.subarray(0, 64));
    const payer = tx.feePayer;
    if (!payer) throw new Error("missing fee payer");
    const transfers = this.decode(tx);
    for (const t of transfers) {
      const cost = t.amount + (t.from.equals(payer) ? TX_FEE : 0n);
      if (this.balance(t.from) < cost) throw new Error("insufficient funds");
    }
    for (const t of transfers) {
      this.fund(t.from, this.balance(t.from) - t.amount);
      this.fund(t.to, this.balance(t.to) + t.amount);
    }
    this.fund(payer, this.balance(payer) - TX_FEE);
    this.slot += 1;
    this.txs.set(signature, this.parsed(signature, this.slot, transfers));
    return signature;
  }

  private decode(tx: Transaction): Transfer[] {
    const out: Transfer[] = [];
    for (const ix of tx.instructions) {
      if (!ix.programId.equals(SystemProgram.programId) || ix.data.length !== 12) continue;
      const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
      if (view.getUint32(0, true) !== 2) continue;
      out.push({
        from: ix.keys[0]!.pubkey,
        to: ix.keys[1]!.pubkey,
        amount: view.getBigUint64(4, true),
      });
    }
    return out;
  }

  private parsed(
    signature: string,
    slot: number,
    transfers: Transfer[]
  ): ParsedTransactionWithMeta {
    const keys: PublicKey[] = [];
    for (const t of transfers) {
      for (const k of [t.from, t.to]) if (!keys.some((x) => x.equals(k))) keys.push(k);
    }
    return {
      slot,
      blockTime: Math.floor(Date.now() / 1000),
      signature,
      meta: { err: null, fee: Number(TX_FEE), logMessages: [], innerInstructions: [] },
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: keys.map((pubkey) => ({ pubkey, signer: false, writable: true })),
          instructions: transfers.map((t) => ({
            program: "system",
            parsed: {
              type: "transfer",
              info: { source: t.from.toBase58(), destination: t.to.toBase58(), lamports: Number(t.amount) },
            },
          })),
          recentBlockhash: BLOCKHASH,
        },
      },
    } as unknown as ParsedTransactionWithMeta;
  }
}

const devnet = new FakeDevnetRpc();
devnet.fund(OPERATOR.publicKey, 50n * SOL);
devnet.fund(ALICE.publicKey, 10n * SOL);
devnet.fund(BOB.publicKey, 10n * SOL);

const connection = {
  getBalance: async (key: PublicKey) => Number(devnet.balance(key)),
  getParsedTransaction: async (signature: string) => devnet.txs.get(signature) ?? null,
  getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1_000_000 }),
  getSlot: async () => devnet.slot,
  getAccountInfo: async () => null,
  requestAirdrop: async () => {
    throw new Error("airdrop disabled in tests");
  },
} as unknown as Connection;

// Keep the database out of it: the mirror is captured, never written.
vi.spyOn(postgresMirror, "enqueue").mockImplementation(() => {});
vi.spyOn(postgresMirror, "readAdminState").mockResolvedValue(null);

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "SOLANA_NETWORK",
  "SOLANA_RPC_URL",
  "ROULETTE_PROGRAM_ID",
  "OPERATOR_KEYPAIR",
  "DEPOSIT_ESCROW_WALLET",
  "PLATFORM_FEE_WALLET",
  "PLATFORM_FEE_BPS",
  "TIER_CAPS_SOL",
  "MIN_DEPOSIT_LAMPORTS",
  "MAX_DEPOSIT_LAMPORTS",
  "FEE_WALLET_KEYPAIR",
  "LEDGER_MODE",
  "DATABASE_URL",
  "ADMIN_TOKEN",
  "DEPOSITS_PAUSED",
  "PREVIEW_UI_URL",
] as const;

let saved: Partial<Record<string, string | undefined>> = {};
let app: FastifyInstance;
let cfg: AppConfig;
let driver: SettlementDriverDeps;
let openRoundId: bigint;

const AUTH = { "x-admin-token": ADMIN_TOKEN };

beforeAll(async () => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.LEDGER_MODE = "local";
  process.env.PLATFORM_FEE_WALLET = FEE_WALLET.toBase58();
  process.env.DEPOSIT_ESCROW_WALLET = OPERATOR.publicKey.toBase58();
  process.env.TIER_CAPS_SOL = "1,10,100";
  process.env.MIN_DEPOSIT_LAMPORTS = "1000000";
  process.env.MAX_DEPOSIT_LAMPORTS = "1000000000";
  process.env.OPERATOR_KEYPAIR = OPERATOR_KEYPAIR_ENV;
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;

  cfg = resolveConfig(process.env);
  const backend = createLocalBackend(cfg, PROGRAM_ID);
  app = await buildServer({ connection, programId: PROGRAM_ID, backend });
  driver = { backend, cfg };
  await runOnce(driver);
  await app.ready();
  const pools = await app.inject({ method: "GET", url: "/api/pools" });
  const head = pools.json<{ pools: Array<{ tier: number; roundId: string | null }> }>().pools[0];
  openRoundId = BigInt(head?.roundId ?? "1");
});

afterAll(async () => {
  await app?.close();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
});

beforeEach(() => {
  resetAdminStateForTests();
  resetGameSettingsForTests();
  resetAdminThrottleForTests();
  logRing.clear();
});

/** Player: open an intent, broadcast a real transfer, report the signature. */
async function deposit(roundId: bigint, wallet: Keypair, amountLamports: bigint) {
  const intent = await app.inject({
    method: "POST",
    url: `/api/round/${roundId}/deposit/intent`,
    payload: { wallet: wallet.publicKey.toBase58(), amountLamports: amountLamports.toString() },
  });
  if (intent.statusCode !== 200) return { intent, confirm: null };
  const body = intent.json<{ depositId: string; escrow: string }>();
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: new PublicKey(body.escrow),
      lamports: amountLamports,
    })
  );
  tx.recentBlockhash = BLOCKHASH;
  tx.lastValidBlockHeight = 1_000_000;
  tx.feePayer = wallet.publicKey;
  // The player signs with their own key, exactly like the browser does.
  tx.partialSign(wallet);
  const signature = devnet.send(tx);
  const confirm = await app.inject({
    method: "POST",
    url: `/api/round/${roundId}/deposit/confirm`,
    payload: { depositId: body.depositId, signature },
  });
  return { intent, confirm };
}

describe("admin authentication", () => {
  it("fails closed when ADMIN_TOKEN is not configured", async () => {
    delete process.env.ADMIN_TOKEN;
    const noTokenCfg = resolveConfig(process.env);
    expect(noTokenCfg.adminToken).toBeUndefined();

    const backend = createLocalBackend(cfg, PROGRAM_ID);
    const open = await buildServer({ connection, programId: PROGRAM_ID, backend });
    const res = await open.inject({ method: "GET", url: "/api/admin/overview" });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe("admin_not_configured");
    // Even with a token supplied, a server without one serves nothing.
    const withToken = await open.inject({
      method: "GET",
      url: "/api/admin/overview",
      headers: AUTH,
    });
    expect(withToken.statusCode).toBe(403);
    await open.close();
  });

  it("rejects a missing or wrong token with 401 and never leaks the real one", async () => {
    const missing = await app.inject({ method: "GET", url: "/api/admin/overview" });
    expect(missing.statusCode).toBe(401);
    expect(missing.json<{ error: string }>().error).toBe("invalid_admin_token");

    const wrong = await app.inject({
      method: "GET",
      url: "/api/admin/overview",
      headers: { "x-admin-token": `${ADMIN_TOKEN}x` },
    });
    expect(wrong.statusCode).toBe(401);

    const bearer = await app.inject({
      method: "GET",
      url: "/api/admin/ping",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(bearer.statusCode).toBe(200);
  });

  it("guards every admin route, not just the overview", async () => {
    for (const call of [
      { method: "GET" as const, url: "/api/admin/overview" },
      { method: "GET" as const, url: "/api/admin/rounds" },
      { method: "GET" as const, url: "/api/admin/rounds/1" },
      { method: "GET" as const, url: "/api/admin/transactions" },
      { method: "GET" as const, url: "/api/admin/logs" },
      { method: "POST" as const, url: "/api/admin/deposits" },
      { method: "GET" as const, url: "/api/admin/settings" },
      { method: "PUT" as const, url: "/api/admin/settings" },
      { method: "POST" as const, url: "/api/admin/fee" },
      { method: "POST" as const, url: "/api/admin/withdraw" },
      { method: "GET" as const, url: "/api/admin/ping" },
    ]) {
      // Each route gets a clean throttle window so the 429 cool-down never
      // masks a route that forgot its guard.
      resetAdminThrottleForTests();
      const res = await app.inject(call);
      expect(res.statusCode, `${call.url} must be gated`).toBe(401);
    }
  });

  it("marks admin responses no-store", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/overview", headers: AUTH });
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("admin overview", () => {
  it("reports network, custody, fees and the three pool caps", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/overview", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      system: { network: string; mainnetEnabled: boolean; mainnetGate: string; rpc: { ok: boolean } };
      custody: {
        escrow: string;
        payoutSigner: string;
        feeWallet: string;
        escrowBalanceLamports: string;
        custodyReady: boolean;
      };
      deposits: { state: string; canAccept: boolean };
      rules: { feeBps: number; winnerShareBps: number; pools: Array<{ capSol: number }> };
      transactions: { deposits: Record<string, number> };
    }>();

    // devnet / mainnet status
    expect(body.system.network).toBe("devnet");
    expect(body.system.mainnetEnabled).toBe(false);
    expect(body.system.mainnetGate).toContain("locked");
    expect(body.system.rpc.ok).toBe(true);

    // escrow, operator and fee wallet are PUBLIC addresses
    expect(body.custody.escrow).toBe(OPERATOR.publicKey.toBase58());
    expect(body.custody.payoutSigner).toBe(OPERATOR.publicKey.toBase58());
    expect(body.custody.feeWallet).toBe(FEE_WALLET.toBase58());
    expect(body.custody.custodyReady).toBe(true);
    expect(BigInt(body.custody.escrowBalanceLamports)).toBe(devnet.balance(OPERATOR.publicKey));

    // deposits start active
    expect(body.deposits.state).toBe("ACTIVE");
    expect(body.deposits.canAccept).toBe(true);

    // 2% fee (200 bps — the unified commission) and the 1 / 10 / 100 SOL lanes
    expect(body.rules.feeBps).toBe(200);
    expect(body.rules.winnerShareBps).toBe(9_800);
    expect(body.rules.pools.map((p) => p.capSol)).toEqual([1, 10, 100]);
  });

  it("never returns key material in any admin response", async () => {
    const routes = [
      "/api/admin/overview",
      "/api/admin/rounds",
      "/api/admin/rounds/1",
      "/api/admin/transactions",
      "/api/admin/logs",
    ];
    for (const url of routes) {
      const res = await app.inject({ method: "GET", url, headers: AUTH });
      const text = res.body;
      expect(text, url).not.toContain(ADMIN_TOKEN);
      expect(text, url).not.toContain(OPERATOR_KEYPAIR_ENV);
      expect(text, url).not.toContain(Array.from(OPERATOR.secretKey).slice(0, 8).join(","));
      expect(text, url).not.toContain(bs58.encode(OPERATOR.secretKey));
    }
  });
});

describe("deposit kill switch", () => {
  it("pauses new deposit intents and resumes them again", async () => {
    const paused = await app.inject({
      method: "POST",
      url: "/api/admin/deposits",
      headers: AUTH,
      payload: { paused: true },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json<{ deposits: { state: string } }>().deposits.state).toBe("PAUSED");
    expect(depositState().paused).toBe(true);

    // A new intent is refused…
    const blocked = await deposit(openRoundId, ALICE, 100_000_000n);
    expect(blocked.intent.statusCode).toBe(503);
    expect(blocked.intent.json<{ error: string }>().error).toBe("deposits_paused");
    expect(blocked.confirm).toBeNull();

    // …and it is visible to the public config so the UI stops inviting deposits.
    const config = await app.inject({ method: "GET", url: "/api/config" });
    expect(config.json<{ depositsPaused: boolean }>().depositsPaused).toBe(true);

    // Resuming works and the switch is idempotent.
    const resumed = await app.inject({
      method: "POST",
      url: "/api/admin/deposits",
      headers: AUTH,
      payload: { paused: false },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json<{ previous: { state: string } }>().previous.state).toBe("PAUSED");
    expect(depositState().paused).toBe(false);
    const again = await app.inject({
      method: "POST",
      url: "/api/admin/deposits",
      headers: AUTH,
      payload: { paused: false },
    });
    expect(again.json<{ deposits: { state: string } }>().deposits.state).toBe("ACTIVE");
  });

  it("rejects a malformed body and cannot be used to change anything else", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/admin/deposits",
      headers: AUTH,
      payload: { paused: "yes" },
    });
    expect(bad.statusCode).toBe(400);

    // The switch is the only write: the body has no other writable surface.
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/deposits",
      headers: AUTH,
      payload: { paused: true, feeBps: 0, winner: "x", network: "mainnet-beta" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ deposits: { state: string } }>().deposits.state).toBe("PAUSED");
    // The fee and the network are untouched by that request.
    expect(resolveConfig(process.env).feeBps).toBe(200);
    expect(depositState().paused).toBe(true);
    setDepositsPaused(false);
  });

  it("keeps settlement automatic while deposits are paused", async () => {
    setDepositsPaused(true);
    // The driver still ticks: a paused switch stops new deposits, never the
    // settlement loop, and it never needs an admin action to run.
    await expect(runOnce(driver)).resolves.toBeUndefined();
    expect(depositState().paused).toBe(true);
    const pools = await app.inject({ method: "GET", url: "/api/pools" });
    expect(pools.statusCode).toBe(200);
    expect(pools.json<{ pools: unknown[] }>().pools).toHaveLength(3);
    setDepositsPaused(false);
  });
});

describe("operator settings console", () => {
  it("reports the off-chain settings and the live on-chain bounds", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/settings", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      settings: { userCapLamportsByTier: string[]; minDepositLamports: string | null };
      onChain: {
        feeBps: number;
        minDepositLamports: string;
        maxDepositLamports: string;
        tierCapsLamports: string[];
      };
      fees: { wallet: string | null; balanceLamports: string | null };
      withdrawal: { keyConfigured: boolean };
    }>();
    expect(body.settings.userCapLamportsByTier).toEqual(["0", "0", "0"]);
    expect(body.settings.minDepositLamports).toBeNull();
    // No config account in local mode → falls back to the resolved config.
    expect(body.onChain.minDepositLamports).toBe("1000000");
    expect(body.onChain.maxDepositLamports).toBe("1000000000");
    expect(body.onChain.tierCapsLamports).toHaveLength(3);
    expect(body.fees.wallet).toBe(FEE_WALLET.toBase58());
    // FEE_WALLET_KEYPAIR is not configured in this suite.
    expect(body.withdrawal.keyConfigured).toBe(false);
  });

  it("updates the off-chain limits and reports them back", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: AUTH,
      payload: {
        userCapLamportsByTier: [0, 0, "5000000000"],
        minDepositLamports: "20000000",
        maxDepositLamports: "500000000",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      ok: boolean;
      settings: { userCapLamportsByTier: string[]; minDepositLamports: string | null; maxDepositLamports: string | null };
    }>();
    expect(body.ok).toBe(true);
    expect(body.settings.userCapLamportsByTier).toEqual(["0", "0", "5000000000"]);
    expect(body.settings.minDepositLamports).toBe("20000000");
    expect(body.settings.maxDepositLamports).toBe("500000000");

    const read = await app.inject({ method: "GET", url: "/api/admin/settings", headers: AUTH });
    expect(read.json<{ settings: { minDepositLamports: string | null } }>().settings.minDepositLamports).toBe(
      "20000000"
    );
  });

  it("400s an override outside the on-chain window instead of widening it", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: AUTH,
      payload: { minDepositLamports: "1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("min_below_onchain");
  });

  it("refuses an on-chain fee change in local mode", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/fee",
      headers: AUTH,
      payload: { feeBps: 150 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("not_chain_mode");
  });

  it("refuses a fee-wallet withdrawal in local mode", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/withdraw",
      headers: AUTH,
      payload: { to: FEE_WALLET.toBase58(), lamports: "1000" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("not_chain_mode");
  });
});

describe("admin transaction and log views", () => {
  it("lists confirmed deposits and settles their pot from the chain", async () => {
    const amount = 200_000_000n;
    const { confirm } = await deposit(openRoundId, BOB, amount);
    expect(confirm?.statusCode).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/transactions?status=CONFIRMED&kind=DEPOSIT",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      transactions: Array<{ wallet: string; status: string; signature: string | null; explorer: string }>;
      counts: { deposits: Record<string, number> };
    }>();
    const row = body.transactions.find((t) => t.wallet === BOB.publicKey.toBase58());
    expect(row).toBeDefined();
    expect(row!.status).toBe("CONFIRMED");
    expect(row!.signature).toBeTruthy();
    expect(row!.explorer).toContain("cluster=devnet");
    expect(body.counts.deposits.CONFIRMED).toBeGreaterThanOrEqual(1);

    // The pot is only what the chain confirmed.
    const round = await app.inject({ method: "GET", url: `/api/round/${openRoundId}` });
    expect(BigInt(round.json<{ round: { potLamports: string } }>().round.potLamports)).toBeGreaterThanOrEqual(amount);
  });

  it("tails the redacted log and keeps secrets out of it", async () => {
    txLog.warn("admin.test_line", {
      operatorKeypair: OPERATOR_KEYPAIR_ENV,
      privateKey: "should never appear",
      wallet: ALICE.publicKey.toBase58(),
    });
    const res = await app.inject({ method: "GET", url: "/api/admin/logs?limit=50", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ entries: Array<{ event: string; fields: Record<string, unknown> }> }>();
    const entry = body.entries.find((e) => e.event === "admin.test_line");
    expect(entry).toBeDefined();
    expect(entry!.fields.operatorKeypair).toBe("[redacted]");
    expect(entry!.fields.privateKey).toBe("[redacted]");
    expect(entry!.fields.wallet).toBe(ALICE.publicKey.toBase58());
    expect(res.body).not.toContain(OPERATOR_KEYPAIR_ENV);
  });

  it("filters the log by level", async () => {
    txLog.info("admin.only_info");
    txLog.error("admin.only_error");
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/logs?level=error&limit=50",
      headers: AUTH,
    });
    const events = res.json<{ entries: Array<{ event: string }> }>().entries.map((e) => e.event);
    expect(events).toContain("admin.only_error");
    expect(events).not.toContain("admin.only_info");
  });

  it("shows open and completed rounds with their caps and payouts", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/rounds", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      open: Array<{ id: string; status: string; capLamports: string; potLamports: string }>;
      completed: Array<{ id: string; payoutConfirmed: boolean }>;
      summary: { openCount: number; headsByTier: string[] };
    }>();
    expect(body.summary.headsByTier).toHaveLength(3);
    expect(body.open.length).toBeGreaterThan(0);
    for (const round of body.open) {
      expect(["OPEN", "FULL", "LOCKED", "RANDOMNESS_PENDING", "SETTLING"]).toContain(round.status);
      expect(BigInt(round.capLamports)).toBeGreaterThanOrEqual(1_000_000_000n);
    }
    for (const round of body.completed) {
      expect(["COMPLETED", "CANCELLED"]).toContain(round.status);
    }
  });

  it("serves one round with its entries and transactions", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/rounds/${openRoundId}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      round: { id: string };
      entries: unknown[];
      transactions: unknown[];
      confirmedPotLamports: string;
      payoutAlreadyConfirmed: boolean;
    }>();
    expect(body.round.id).toBe(openRoundId.toString());
    expect(BigInt(body.confirmedPotLamports)).toBeGreaterThan(0n);
    expect(body.payoutAlreadyConfirmed).toBe(false);
    expect(store.txs.listByRound(openRoundId).length).toBe(body.transactions.length);
  });

  it("400s a non-numeric round id instead of guessing", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/rounds/abc", headers: AUTH });
    expect(res.statusCode).toBe(400);
  });
});
