/**
 * Refund-or-wait DECISION WINDOW — end to end through the real HTTP API.
 *
 * The unit tests (laneTimeout.test.ts) pin the settlement functions and the
 * component test (apps/web/lib/refundChoice.test.tsx) pins the prompt markup.
 * This file closes the gap in between: it boots the REAL Fastify server
 * (`buildServer`) on the in-process devnet ledger and drives the exact requests
 * the UI makes, so the whole chain is exercised as one product:
 *
 *     UI fetch  →  POST /api/round/:id/refund | /wait
 *               →  requestRoundRefund / waitLongerOnRound
 *               →  backend.runLifecycle("cancel")  (exact on-chain refund walk)
 *
 * and the read paths the UI renders the prompt from:
 *
 *     GET /api/round/current?tier=0   → round.refundWindow
 *     GET /api/pools                  → pools[].refundWindow
 *
 * Without the window a quiet, funded round used to be refunded silently after
 * `ROUND_TIMEOUT_MS`; the player only saw their deposit vanish. These tests pin
 * that the players are ASKED first, that "keep waiting" cancels nothing, and
 * that "refund now" is the exact `cancel_round` refund + lane reopen.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import { resolveConfig } from "@solana-roulette/config";
import { buildServer } from "./server.js";
import { createLocalBackend, type ChainBackend } from "./backend.js";
import { store } from "./store.js";

const PROGRAM_ID = new PublicKey("F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos");
const OPERATOR = Keypair.fromSeed(new Uint8Array(32).fill(41));
const FEE_WALLET = new PublicKey("6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR");
const PLAYER = new PublicKey(new Uint8Array(32).fill(101));

const DEPOSIT = 100_000_000n; // 0.1 SOL — well below the 1 SOL lane cap
const ROUND_TIMEOUT_MS = 60_000;
const REFUND_WINDOW_MS = 30_000;

/** The exact points of every SSE event the server emits during these tests. */
const sseEvents: string[] = [];

const ENV_KEYS = [
  "SOLANA_NETWORK",
  "SOLANA_RPC_URL",
  "ROULETTE_PROGRAM_ID",
  "OPERATOR_KEYPAIR",
  "PLATFORM_FEE_WALLET",
  "DEPOSIT_ESCROW_WALLET",
  "PLATFORM_FEE_BPS",
  "TIER_CAPS_SOL",
  "MIN_DEPOSIT_LAMPORTS",
  "MAX_DEPOSIT_LAMPORTS",
  "MAX_ROUND_SIZE_LAMPORTS",
  "REVEAL_OFFSET_SLOTS",
  "LEDGER_MODE",
  "SETTLEMENT_DRIVER",
  "SETTLEMENT_POLL_MS",
  "DEPOSIT_RECONCILE_MS",
  "ROUND_TIMEOUT_MS",
  "REFUND_WINDOW_MS",
  "LOG_LEVEL",
  "PREVIEW_UI_URL",
] as const;

let savedEnv: Partial<Record<string, string | undefined>> = {};
let app: FastifyInstance;
let backend: ChainBackend;
let roundId: bigint;
let offEvents: (() => void) | undefined;

// A connection the server never truly needs (the backend is provided), but
// which must answer the handful of read methods touched during boot.
const connection = {
  getBalance: async () => 0,
  getParsedTransaction: async () => null,
  getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }),
  getSlot: async () => 0,
  getAccountInfo: async () => null,
  getMultipleAccountsInfo: async () => [],
  requestAirdrop: async () => {
    throw new Error("airdrop disabled in tests");
  },
} as unknown as Connection;

async function current(tier = 0) {
  const res = await app.inject({ method: "GET", url: `/api/round/current?tier=${tier}` });
  expect(res.statusCode).toBe(200);
  return res.json<{
    round: (Record<string, unknown> & {
      refundWindow: null | {
        active: boolean;
        status: string;
        msRemaining: number;
        deadline: number | null;
        canRefund: boolean;
        canWait: boolean;
      };
    }) | null;
    entries: Array<Record<string, unknown>>;
  }>();
}

/** Put the funded round back inside the decision window the way the clock would. */
function rewindIntoWindow() {
  store.clearOpenSeen(roundId);
  store.clearRefundWindow(roundId);
  store.markOpenSeen(roundId, Date.now() - (ROUND_TIMEOUT_MS - 15_000));
}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  Object.assign(process.env, {
    SOLANA_NETWORK: "devnet",
    SOLANA_RPC_URL: "http://127.0.0.1:1/fake-devnet",
    ROULETTE_PROGRAM_ID: PROGRAM_ID.toBase58(),
    OPERATOR_KEYPAIR: JSON.stringify(Array.from(OPERATOR.secretKey)),
    PLATFORM_FEE_WALLET: FEE_WALLET.toBase58(),
    DEPOSIT_ESCROW_WALLET: OPERATOR.publicKey.toBase58(),
    PLATFORM_FEE_BPS: "200",
    TIER_CAPS_SOL: "1,10,100",
    MIN_DEPOSIT_LAMPORTS: "10000000",
    MAX_DEPOSIT_LAMPORTS: "1000000000",
    MAX_ROUND_SIZE_LAMPORTS: "100000000000",
    REVEAL_OFFSET_SLOTS: "32",
    LEDGER_MODE: "local",
    // No automatic ticks: the test drives the endpoints and inspects the state
    // deterministically. The route handlers still receive the real driver deps.
    SETTLEMENT_DRIVER: "off",
    SETTLEMENT_POLL_MS: "600000",
    DEPOSIT_RECONCILE_MS: "600000",
    ROUND_TIMEOUT_MS: String(ROUND_TIMEOUT_MS),
    REFUND_WINDOW_MS: String(REFUND_WINDOW_MS),
    LOG_LEVEL: "silent",
    PREVIEW_UI_URL: "",
  });

  vi.spyOn(console, "log").mockImplementation(() => {});
  backend = createLocalBackend(resolveConfig(), PROGRAM_ID);
  app = await buildServer({ connection, programId: PROGRAM_ID, backend });

  offEvents = store.addListener((ev) => sseEvents.push(`${ev.type}:${JSON.stringify(ev.data)}`));

  // A quiet lane round with one deposit — the exact scenario that used to be
  // refunded silently. Created directly through the backend so the test owns
  // its pot precisely.
  roundId = (await backend.runLifecycle("create", { tier: 0 }))!.roundId;
  await backend.deposit({ roundId, wallet: PLAYER, lamports: DEPOSIT });
  expect(backend.ledger.getRound(roundId)!.status).toBe("OPEN");
  expect(backend.ledger.getRound(roundId)!.pot).toBe(DEPOSIT);
});

afterAll(async () => {
  offEvents?.();
  await app?.close();
  for (const id of [roundId, roundId + 1n]) {
    store.clearOpenSeen(id);
    store.clearRefundWindow(id);
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

describe("refund decision window through the HTTP API", () => {
  it("shows no prompt for a freshly observed funded round", async () => {
    store.clearOpenSeen(roundId);
    const { round } = await current();
    expect(round).not.toBeNull();
    expect(round!.refundWindow).toBeNull();
  });

  it("exposes the prompt on /api/round/current and /api/pools once the window opens", async () => {
    rewindIntoWindow();
    const { round } = await current();
    const w = round!.refundWindow;
    expect(w).not.toBeNull();
    expect(w!.active).toBe(true);
    expect(w!.status).toBe("pending");
    expect(w!.canRefund).toBe(true);
    expect(w!.canWait).toBe(true);
    expect(w!.msRemaining).toBeGreaterThan(0);
    expect(w!.msRemaining).toBeLessThanOrEqual(15_000);

    // The pool card renders from /api/pools, so the window must be there too.
    const poolsRes = await app.inject({ method: "GET", url: "/api/pools" });
    expect(poolsRes.statusCode).toBe(200);
    const { pools } = poolsRes.json<{
      pools: Array<{ tier: number; roundId: string | null; refundWindow: { active: boolean; status: string } | null }>;
    }>();
    const tier0 = pools.find((p) => p.tier === 0)!;
    expect(tier0.roundId).toBe(roundId.toString());
    expect(tier0.refundWindow).not.toBeNull();
    expect(tier0.refundWindow!.active).toBe(true);
    expect(tier0.refundWindow!.status).toBe("pending");

    // The prompt was announced to connected clients over SSE exactly once.
    expect(sseEvents.filter((e) => e.startsWith("refund_window:") && e.includes('"pending"')).length).toBe(1);
  });

  it('"keep waiting" extends the deadline, cancels nothing and clears the prompt', async () => {
    rewindIntoWindow();
    // Arm the window so the pending state exists before the player answers.
    await current();

    const res = await app.inject({ method: "POST", url: `/api/round/${roundId}/wait` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; status: string; refundWindow: { status: string; msRemaining: number } }>();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("extended");
    // The clock was re-anchored to now, so the round is merely filling again —
    // no prompt is showing and a whole fresh timeout must pass.
    expect(body.refundWindow.status).toBe("open");
    expect(body.refundWindow.active).toBe(false);

    // Nothing was refunded and nothing was cancelled: the round is untouched
    // and its deposit is still in the pot.
    expect(backend.ledger.getRound(roundId)!.status).toBe("OPEN");
    expect(backend.ledger.getRound(roundId)!.pot).toBe(DEPOSIT);
    expect(backend.ledger.receivedBy(PLAYER)).toBe(0n);

    // A whole fresh timeout must now pass before the round is asked again.
    const { round } = await current();
    expect(round!.refundWindow).toBeNull();
    expect(sseEvents.some((e) => e.startsWith("refund_window:") && e.includes('"extended"'))).toBe(true);
  });

  it('"refund now" refunds the player exactly and reopens the lane', async () => {
    rewindIntoWindow();
    await current(); // arm the window

    const before = await backend.getHeadByTier();
    const res = await app.inject({ method: "POST", url: `/api/round/${roundId}/refund` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; status: string; signature: string | null; newRoundId: string | null }>();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("refunded");
    expect(body.signature).toBeTruthy();
    expect(body.newRoundId).not.toBeNull();

    // The on-chain-equivalent cancel refunded the participant EXACTLY.
    expect(backend.ledger.getRound(roundId)!.status).toBe("CANCELLED");
    expect(backend.ledger.getRound(roundId)!.pot).toBe(0n);
    expect(backend.ledger.receivedBy(PLAYER)).toBe(DEPOSIT);

    // The lane reopened with a new head, so the same wallet can deposit again.
    const after = await backend.getHeadByTier();
    expect(after[0]).toBeGreaterThan(before[0]);
    expect(after[0]!.toString()).toBe(body.newRoundId);

    // The prompt is gone from the read paths.
    const { round } = await current();
    expect(round!.id).toBe(body.newRoundId);
    expect(round!.refundWindow).toBeNull();
    expect(sseEvents.some((e) => e.startsWith("refund_window:") && e.includes('"refunded"'))).toBe(true);
  });

  it("refuses a second refund on the already-cancelled round", async () => {
    const res = await app.inject({ method: "POST", url: `/api/round/${roundId}/refund` });
    expect(res.statusCode).toBe(409);
    const body = res.json<{ ok: boolean; status: string; detail: string }>();
    expect(body.ok).toBe(false);
    expect(body.status).toBe("CANCELLED");
  });

  it("refuses to wait on a round with no deposit to protect", async () => {
    const fresh = (await backend.getHeadByTier())[0]!;
    const res = await app.inject({ method: "POST", url: `/api/round/${fresh}/wait` });
    expect(res.statusCode).toBe(409);
    const body = res.json<{ ok: boolean; detail: string }>();
    expect(body.ok).toBe(false);
    expect(body.detail).toMatch(/no longer waiting|not accepting/i);
  });

  it("rejects a malformed round id and reports an unknown round as 404", async () => {
    const bad = await app.inject({ method: "POST", url: "/api/round/not-a-number/refund" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: string }>().error).toBe("round id must be numeric");

    const missing = await app.inject({ method: "POST", url: "/api/round/999999/refund" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ error: string }>().error).toBe("round_not_found");

    const missingWait = await app.inject({ method: "POST", url: "/api/round/999999/wait" });
    expect(missingWait.statusCode).toBe(404);
    expect(missingWait.json<{ error: string }>().error).toBe("round_not_found");
  });
});
