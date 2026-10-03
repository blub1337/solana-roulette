/**
 * Low-traffic lane safety valve.
 *
 * An OPEN round only leaves OPEN by reaching exactly its tier cap, so a quiet
 * lane can sit OPEN forever. Because a wallet may only enter a round once, that
 * would lock every participant out of the lane permanently — the
 * `already_deposited` trap a user hits when they try to deposit again (or think
 * they are "joining a second pool") while their wallet already sits in a stuck
 * round.
 *
 * The fix: after `ROUND_TIMEOUT_MS` of a FUNDED round being observed OPEN, the
 * driver cancels it (operator-signed `cancel_round`, which refunds every
 * participant exactly on chain) and opens a fresh round, so deposits proceed.
 * These tests pin that behaviour, the guards around it, and the on-demand
 * operator action.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  advanceLaneManually,
  advanceTierLane,
  DEFAULT_REFUND_WINDOW_MS,
  DEFAULT_ROUND_TIMEOUT_MS,
  laneRefundWindow,
  MIN_REFUND_WINDOW_MS,
  MIN_ROUND_TIMEOUT_MS,
  refundWindowFor,
  refundWindowMs,
  requestRoundRefund,
  roundTimeoutMs,
  waitLongerOnRound,
} from "./settlement.js";
import { createLocalBackend } from "./backend.js";
import type { ChainBackend, LifecycleAction, LifecycleArgs } from "./backend.js";
import type { RoundData } from "@solana-roulette/verification";
import { resolveConfig } from "@solana-roulette/config";
import { store } from "./store.js";

function makeRound(over: Partial<RoundData> = {}): RoundData {
  return {
    id: 1n,
    status: "OPEN",
    escrow: new PublicKey(new Uint8Array(32).fill(3)),
    pot: 0n,
    totalWeight: 0n,
    participantCount: 0,
    lockSlot: 0n,
    revealSlot: 0n,
    feeBps: 200,
    randomness: new Uint8Array(32),
    winningTicket: 0n,
    winner: PublicKey.default,
    feeLamports: 0n,
    payoutLamports: 0n,
    payoutAccount: new Uint8Array(32),
    tier: 0,
    bump: 255,
    revealInput: new Uint8Array(32),
    ...over,
  };
}

interface Harness {
  backend: ChainBackend;
  calls: { action: LifecycleAction; roundId?: bigint; tier?: number }[];
  rounds: Map<string, RoundData>;
  heads: bigint[];
  /** Toggle the cancel result so a failed refund can be simulated. */
  cancelOk: boolean;
}

function harness(round: RoundData, heads: bigint[]): Harness {
  const rounds = new Map<string, RoundData>([[round.id.toString(), round]]);
  const calls: { action: LifecycleAction; roundId?: bigint; tier?: number }[] = [];
  let nextId = 1_000n;
  const h: Harness = {
    calls,
    rounds,
    heads,
    cancelOk: true,
    backend: {
      mode: "chain",
      realFunds: true,
      async getRound(id) {
        return rounds.get(id.toString()) ?? null;
      },
      async getParticipants() {
        return [];
      },
      async getGlobalConfig() {
        return null;
      },
      async getCurrentSlot() {
        return 0n;
      },
      async getRevealBlockhash() {
        return null;
      },
      async getHeadByTier() {
        return [...heads];
      },
      async runLifecycle(action: LifecycleAction, args: LifecycleArgs = {}) {
        calls.push({ action, roundId: args.roundId, tier: args.tier });
        if (action === "create") {
          nextId += 1n;
          const created = makeRound({ id: nextId, tier: args.tier ?? 0, status: "OPEN", pot: 0n });
          rounds.set(nextId.toString(), created);
          heads[args.tier ?? 0] = nextId;
          return { signature: `sig-create-${nextId}`, roundId: nextId };
        }
        if (action === "cancel") {
          if (!h.cancelOk) return null;
          const r = rounds.get(args.roundId!.toString());
          if (r) r.status = "CANCELLED";
          return { signature: `sig-cancel-${args.roundId}`, roundId: args.roundId! };
        }
        return { signature: `sig-${action}`, roundId: args.roundId ?? 0n };
      },
      async deposit() {
        throw new Error("not used");
      },
      treasuryAccrued() {
        return 0n;
      },
    },
  };
  return h;
}

const cfg = resolveConfig({} as NodeJS.ProcessEnv);

let savedHeads: bigint[];
let savedTimeout: string | undefined;
let savedWindow: string | undefined;

beforeEach(() => {
  savedHeads = [...store.currentRoundIdByTier];
  savedTimeout = process.env.ROUND_TIMEOUT_MS;
  savedWindow = process.env.REFUND_WINDOW_MS;
});

afterEach(() => {
  store.currentRoundIdByTier = [...savedHeads];
  if (savedTimeout === undefined) delete process.env.ROUND_TIMEOUT_MS;
  else process.env.ROUND_TIMEOUT_MS = savedTimeout;
  if (savedWindow === undefined) delete process.env.REFUND_WINDOW_MS;
  else process.env.REFUND_WINDOW_MS = savedWindow;
  // Forget the open clock AND the refund window for the ids these tests used.
  for (const id of [5n, 9n, 1n, 2n]) {
    store.clearOpenSeen(id);
    store.clearRefundWindow(id);
  }
});

describe("roundTimeoutMs (env parsing)", () => {
  it("defaults to 15 minutes when unset or empty", () => {
    delete process.env.ROUND_TIMEOUT_MS;
    expect(roundTimeoutMs()).toBe(DEFAULT_ROUND_TIMEOUT_MS);
    expect(DEFAULT_ROUND_TIMEOUT_MS).toBe(900_000);
    process.env.ROUND_TIMEOUT_MS = "  ";
    expect(roundTimeoutMs()).toBe(DEFAULT_ROUND_TIMEOUT_MS);
  });

  it("treats explicit 0 / negatives as disabled", () => {
    process.env.ROUND_TIMEOUT_MS = "0";
    expect(roundTimeoutMs()).toBe(0);
    process.env.ROUND_TIMEOUT_MS = "-5";
    expect(roundTimeoutMs()).toBe(0);
  });

  it("keeps the valve ON for a malformed value instead of silently disabling it", () => {
    process.env.ROUND_TIMEOUT_MS = "not-a-number";
    expect(roundTimeoutMs()).toBe(DEFAULT_ROUND_TIMEOUT_MS);
  });

  it("clamps small positive values up to the floor", () => {
    process.env.ROUND_TIMEOUT_MS = "100";
    expect(roundTimeoutMs()).toBe(MIN_ROUND_TIMEOUT_MS);
    process.env.ROUND_TIMEOUT_MS = "300000";
    expect(roundTimeoutMs()).toBe(300_000);
  });
});

describe("stale OPEN round timeout (low-traffic lanes keep accepting deposits)", () => {
  it("does NOT touch a freshly observed funded OPEN round", async () => {
    process.env.ROUND_TIMEOUT_MS = "60000";
    const h = harness(makeRound({ id: 5n, tier: 0, status: "OPEN", pot: 100_000_000n }), [5n, 0n, 0n]);
    await advanceTierLane(0, { backend: h.backend, cfg });
    expect(h.calls).toEqual([]);
    // The clock started on first observation.
    expect(store.openSeenAtFor(5n)).not.toBeNull();
  });

  it("cancels AND reopens a funded OPEN round once it is older than the timeout", async () => {
    process.env.ROUND_TIMEOUT_MS = "60000";
    // Window off: this pins the pure safety valve, i.e. what happens when the
    // players never answer the prompt.
    process.env.REFUND_WINDOW_MS = "0";
    const h = harness(makeRound({ id: 5n, tier: 0, status: "OPEN", pot: 100_000_000n }), [5n, 0n, 0n]);
    store.markOpenSeen(5n, Date.now() - 120_000); // observed OPEN two minutes ago

    await advanceTierLane(0, { backend: h.backend, cfg });

    expect(h.calls.map((c) => c.action)).toEqual(["cancel", "create"]);
    expect(h.calls[0]!.roundId).toBe(5n);
    expect(h.calls[1]!.tier).toBe(0);
    // The stuck round is refunded and the lane now points at a fresh round.
    expect(h.rounds.get("5")!.status).toBe("CANCELLED");
    expect(h.heads[0]).not.toBe(5n);
    expect(h.rounds.get(h.heads[0].toString())!.status).toBe("OPEN");
    // A wallet that deposited in the old round can deposit in the new one: the
    // gate is keyed by round id, and the head has moved on.
    expect(store.currentRoundIdByTier[0]).toBe(h.heads[0]);
  });

  it("leaves an EMPTY OPEN round alone (nothing is blocked, nothing to refund)", async () => {
    process.env.ROUND_TIMEOUT_MS = "60000";
    const h = harness(makeRound({ id: 5n, tier: 0, status: "OPEN", pot: 0n }), [5n, 0n, 0n]);
    store.markOpenSeen(5n, Date.now() - 120_000);

    await advanceTierLane(0, { backend: h.backend, cfg });
    expect(h.calls).toEqual([]);
  });

  it("can be disabled entirely with ROUND_TIMEOUT_MS=0", async () => {
    process.env.ROUND_TIMEOUT_MS = "0";
    const h = harness(makeRound({ id: 5n, tier: 0, status: "OPEN", pot: 100_000_000n }), [5n, 0n, 0n]);
    store.markOpenSeen(5n, Date.now() - 120_000);

    await advanceTierLane(0, { backend: h.backend, cfg });
    expect(h.calls).toEqual([]);
  });

  it("orphans the cancelled round's ledger entries so they stop counting", async () => {
    process.env.ROUND_TIMEOUT_MS = "60000";
    process.env.REFUND_WINDOW_MS = "0";
    const roundId = 5n;
    const wallet = new PublicKey(new Uint8Array(32).fill(11)).toBase58();
    const h = harness(makeRound({ id: roundId, tier: 0, status: "OPEN", pot: 100_000_000n }), [5n, 0n, 0n]);
    const { tx } = store.txs.begin({
      kind: "DEPOSIT",
      idempotencyKey: `deposit:${roundId}:${wallet}`,
      roundId: roundId.toString(),
      tier: 0,
      wallet,
      recipient: "ESCROW",
      network: "devnet",
      depositAmountLamports: "100000000",
    });
    store.txs.settle(tx.id, "CONFIRMED", { signature: "s".repeat(64) });
    expect(store.txs.confirmedPotLamports(roundId)).toBe(100_000_000n);

    store.markOpenSeen(roundId, Date.now() - 120_000);
    await advanceTierLane(0, { backend: h.backend, cfg });

    expect(h.calls.map((c) => c.action)).toEqual(["cancel", "create"]);
    // The refund happened on chain, so the ledger must stop treating the entry
    // as an entry (and the pot as the pot) for the cancelled round.
    expect(store.txs.get(tx.id)?.depositStatus).toBe("FAILED");
    expect(store.txs.confirmedPotLamports(roundId)).toBe(0n);
  });

  it("re-arms instead of hammering when the cancel fails", async () => {
    process.env.ROUND_TIMEOUT_MS = "60000";
    process.env.REFUND_WINDOW_MS = "0";
    const h = harness(makeRound({ id: 5n, tier: 0, status: "OPEN", pot: 100_000_000n }), [5n, 0n, 0n]);
    h.cancelOk = false;
    store.markOpenSeen(5n, Date.now() - 120_000);

    await advanceTierLane(0, { backend: h.backend, cfg });

    // It tried to cancel, never created a second round, and cleared the clock
    // so the next attempt waits another full timeout.
    expect(h.calls.map((c) => c.action)).toEqual(["cancel"]);
    expect(store.openSeenAtFor(5n)).toBeNull();
    expect(h.heads[0]).toBe(5n);
  });
});

/**
 * The player's choice.
 *
 * A funded round that never fills used to be refunded silently after the
 * timeout: the deposit vanished from the pool and came back to the wallet with
 * no say from the player. Now the round first enters a DECISION WINDOW and asks
 * "refund now, or keep waiting?". These tests pin the window, both answers, and
 * the fact that nothing is refunded while the window is still open.
 */
describe("refund-or-wait decision window", () => {
  it("defaults to a two-minute prompt, clamped and disable-able", () => {
    delete process.env.REFUND_WINDOW_MS;
    expect(refundWindowMs()).toBe(DEFAULT_REFUND_WINDOW_MS);
    expect(DEFAULT_REFUND_WINDOW_MS).toBe(120_000);
    process.env.REFUND_WINDOW_MS = "0";
    expect(refundWindowMs()).toBe(0);
    process.env.REFUND_WINDOW_MS = "1000";
    expect(refundWindowMs()).toBe(MIN_REFUND_WINDOW_MS);
    process.env.REFUND_WINDOW_MS = "nonsense";
    expect(refundWindowMs()).toBe(DEFAULT_REFUND_WINDOW_MS);
  });

  it("does NOT refund while the window is still open — the players are asked first", async () => {
    process.env.ROUND_TIMEOUT_MS = "60000";
    process.env.REFUND_WINDOW_MS = "30000";
    const h = harness(makeRound({ id: 5n, tier: 0, status: "OPEN", pot: 100_000_000n }), [5n, 0n, 0n]);
    // 45 s into a 60 s timeout: inside the final 30 s, so the prompt is armed.
    store.markOpenSeen(5n, Date.now() - 45_000);

    await advanceTierLane(0, { backend: h.backend, cfg });

    // No cancel, no create — the round simply asks.
    expect(h.calls).toEqual([]);
    const window = laneRefundWindow(0, { backend: h.backend, cfg }, h.rounds.get("5")!);
    expect(window.active).toBe(true);
    expect(window.status).toBe("pending");
    expect(window.canRefund).toBe(true);
    expect(window.canWait).toBe(true);
    expect(window.msRemaining).toBeGreaterThan(0);
    expect(window.msRemaining).toBeLessThanOrEqual(15_000);
  });

  it("reports no window for a fresh round (the prompt is not a hair-trigger)", async () => {
    process.env.ROUND_TIMEOUT_MS = "60000";
    process.env.REFUND_WINDOW_MS = "30000";
    const h = harness(makeRound({ id: 5n, tier: 0, status: "OPEN", pot: 100_000_000n }), [5n, 0n, 0n]);
    await advanceTierLane(0, { backend: h.backend, cfg });

    const window = laneRefundWindow(0, { backend: h.backend, cfg }, h.rounds.get("5")!);
    expect(window.active).toBe(false);
    expect(store.refundDeadlineFor(5n)).toBeNull();
  });

  it("refunds once the window closes unanswered (nobody chose to wait)", async () => {
    process.env.ROUND_TIMEOUT_MS = "60000";
    process.env.REFUND_WINDOW_MS = "30000";
    const h = harness(makeRound({ id: 5n, tier: 0, status: "OPEN", pot: 100_000_000n }), [5n, 0n, 0n]);
    store.markOpenSeen(5n, Date.now() - 45_000);
    // Arm the window, then let it expire without an answer.
    store.armRefundWindow(5n, Date.now() - 1);

    await advanceTierLane(0, { backend: h.backend, cfg });

    expect(h.calls.map((c) => c.action)).toEqual(["cancel", "create"]);
    expect(h.rounds.get("5")!.status).toBe("CANCELLED");
    expect(store.refundDeadlineFor(5n)).toBeNull();
  });

  it('"keep waiting" extends the deadline and cancels nothing', async () => {
    process.env.ROUND_TIMEOUT_MS = "60000";
    process.env.REFUND_WINDOW_MS = "30000";
    const h = harness(makeRound({ id: 5n, tier: 0, status: "OPEN", pot: 100_000_000n }), [5n, 0n, 0n]);
    store.markOpenSeen(5n, Date.now() - 45_000);
    await advanceTierLane(0, { backend: h.backend, cfg });
    expect(h.calls).toEqual([]);

    const result = await waitLongerOnRound(0, { backend: h.backend, cfg }, 5n);

    expect(result.ok).toBe(true);
    expect(result.status).toBe("extended");
    expect(h.calls).toEqual([]); // still no chain write
    // The round is no longer inside its window: the clock was re-anchored to
    // now, so a whole fresh timeout must pass before it is asked again.
    const window = laneRefundWindow(0, { backend: h.backend, cfg }, h.rounds.get("5")!);
    expect(window.active).toBe(false);
    expect(store.refundDeadlineFor(5n)).toBeNull();
    const seenAt = store.openSeenAtFor(5n);
    expect(seenAt).not.toBeNull();
    expect(Date.now() - seenAt!).toBeLessThan(2_000);
  });

  it('"refund now" cancels the round immediately and reopens the lane', async () => {
    process.env.ROUND_TIMEOUT_MS = "60000";
    process.env.REFUND_WINDOW_MS = "30000";
    const h = harness(makeRound({ id: 5n, tier: 0, status: "OPEN", pot: 100_000_000n }), [5n, 0n, 0n]);
    store.markOpenSeen(5n, Date.now() - 45_000);
    await advanceTierLane(0, { backend: h.backend, cfg });

    const result = await requestRoundRefund(0, { backend: h.backend, cfg }, 5n);

    expect(result.ok).toBe(true);
    expect(result.status).toBe("refunded");
    expect(result.signature).toMatch(/sig-cancel/);
    expect(h.calls.map((c) => c.action)).toEqual(["cancel", "create"]);
    expect(h.rounds.get("5")!.status).toBe("CANCELLED");
    expect(store.currentRoundIdByTier[0]).toBe(h.heads[0]);
    expect(store.refundDeadlineFor(5n)).toBeNull();
  });

  it("refuses to refund a round that is not open or has no deposits", async () => {
    process.env.ROUND_TIMEOUT_MS = "60000";
    const settling = harness(
      makeRound({ id: 5n, tier: 0, status: "RANDOMNESS_PENDING", pot: 1_000n }),
      [5n, 0n, 0n]
    );
    const refused = await requestRoundRefund(0, { backend: settling.backend, cfg }, 5n);
    expect(refused.ok).toBe(false);
    expect(settling.calls).toEqual([]);

    const empty = harness(makeRound({ id: 9n, tier: 1, status: "OPEN", pot: 0n }), [0n, 9n, 0n]);
    const nothing = await requestRoundRefund(1, { backend: empty.backend, cfg }, 9n);
    expect(nothing.ok).toBe(false);
    expect(empty.calls).toEqual([]);
  });

  it("broadcasts the prompt exactly once per round", async () => {
    process.env.ROUND_TIMEOUT_MS = "60000";
    process.env.REFUND_WINDOW_MS = "30000";
    const h = harness(makeRound({ id: 5n, tier: 0, status: "OPEN", pot: 100_000_000n }), [5n, 0n, 0n]);
    const seenAt = Date.now() - 45_000;
    const events: string[] = [];
    const off = store.addListener((ev) => events.push(`${ev.type}:${ev.data?.status}`));
    try {
      refundWindowFor(5n, 0, { backend: h.backend, cfg }, seenAt, 60_000);
      refundWindowFor(5n, 0, { backend: h.backend, cfg }, seenAt, 60_000);
      refundWindowFor(5n, 0, { backend: h.backend, cfg }, seenAt, 60_000);
    } finally {
      off();
    }
    expect(events).toEqual(["refund_window:pending"]);
  });
});

describe("advanceLaneManually (operator reset, no waiting)", () => {
  it("refunds the lane's OPEN round and opens a fresh one immediately", async () => {
    const h = harness(makeRound({ id: 9n, tier: 1, status: "OPEN", pot: 100_000_000n }), [0n, 9n, 0n]);

    const result = await advanceLaneManually(1, { backend: h.backend, cfg });

    expect(result.cancelled).toBe(true);
    expect(result.roundId).toBe("9");
    expect(result.cancelSignature).toMatch(/sig-cancel/);
    expect(result.newRoundId).not.toBeNull();
    expect(h.calls.map((c) => c.action)).toEqual(["cancel", "create"]);
    expect(h.rounds.get("9")!.status).toBe("CANCELLED");
    expect(store.currentRoundIdByTier[1]).toBe(h.heads[1]);
  });

  it("orphans the reset round's ledger entries (manual operator reset)", async () => {
    const roundId = 9n;
    const wallet = new PublicKey(new Uint8Array(32).fill(12)).toBase58();
    const h = harness(makeRound({ id: roundId, tier: 1, status: "OPEN", pot: 100_000_000n }), [0n, 9n, 0n]);
    const { tx } = store.txs.begin({
      kind: "DEPOSIT",
      idempotencyKey: `deposit:${roundId}:${wallet}`,
      roundId: roundId.toString(),
      tier: 1,
      wallet,
      recipient: "ESCROW",
      network: "devnet",
      depositAmountLamports: "100000000",
    });
    store.txs.settle(tx.id, "CONFIRMED", { signature: "m".repeat(64) });

    const result = await advanceLaneManually(1, { backend: h.backend, cfg });
    expect(result.cancelled).toBe(true);
    expect(store.txs.get(tx.id)?.depositStatus).toBe("FAILED");
    expect(store.txs.confirmedPotLamports(roundId)).toBe(0n);
  });

  it("refuses to touch a round that is already settling", async () => {
    const h = harness(makeRound({ id: 9n, tier: 1, status: "RANDOMNESS_PENDING", pot: 1_000n }), [0n, 9n, 0n]);

    const result = await advanceLaneManually(1, { backend: h.backend, cfg });

    expect(result.cancelled).toBe(false);
    expect(result.newRoundId).toBeNull();
    expect(result.detail).toMatch(/only an OPEN round/);
    expect(h.calls).toEqual([]);
  });

  it("opens a round when the lane has none yet", async () => {
    const h = harness(makeRound({ id: 9n, tier: 1, status: "OPEN", pot: 0n }), [0n, 9n, 0n]);
    // Point the lane at an id with no round account.
    h.heads[1] = 50n;

    const result = await advanceLaneManually(1, { backend: h.backend, cfg });

    expect(result.roundId).toBeNull();
    expect(result.newRoundId).not.toBeNull();
    expect(h.calls.map((c) => c.action)).toEqual(["create"]);
  });
});

/**
 * End-to-end through the REAL ChainBackend implementation (the local ledger,
 * which mirrors the program instruction-for-instruction), not a test fake. This
 * is the user's scenario: a wallet deposits into a quiet lane, the round never
 * fills, the wallet is therefore blocked from depositing again — and the
 * timeout refunds the round and reopens the lane so the deposit can proceed.
 */
describe("low-traffic lane recovers end-to-end (local ledger backend)", () => {
  const PROGRAM_ID = new PublicKey("F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos");
  const wallet = new PublicKey(new Uint8Array(32).fill(7));

  it("refunds the stuck round and lets the same wallet deposit into the new round", async () => {
    process.env.ROUND_TIMEOUT_MS = "60000";
    const backend = createLocalBackend(cfg, PROGRAM_ID);

    // A 1-SOL lane round with a single 0.1 SOL deposit — far below the cap, so
    // it would otherwise sit OPEN forever.
    await backend.runLifecycle("create", { tier: 0 });
    await backend.deposit({ roundId: 1n, wallet, lamports: 100_000_000n });
    expect(backend.ledger.getRound(1n)!.status).toBe("OPEN");
    expect(backend.ledger.getRound(1n)!.pot).toBe(100_000_000n);

    // The lane is quiet: the round has been observably OPEN for two minutes.
    store.markOpenSeen(1n, Date.now() - 120_000);
    await advanceTierLane(0, { backend, cfg });

    // The stuck round was cancelled and every participant refunded exactly.
    expect(backend.ledger.getRound(1n)!.status).toBe("CANCELLED");
    expect(backend.ledger.receivedBy(wallet)).toBe(100_000_000n);
    expect(backend.ledger.getRound(1n)!.pot).toBe(0n);

    // The lane reopened, so the SAME wallet can deposit again — the exact thing
    // `already_deposited` used to block forever.
    const newRound = backend.ledger.headByTier[0];
    expect(newRound).toBe(2n);
    expect(backend.ledger.getRound(newRound)!.status).toBe("OPEN");
    await expect(
      backend.deposit({ roundId: newRound, wallet, lamports: 100_000_000n })
    ).resolves.toBeTruthy();
    expect(backend.ledger.getRound(newRound)!.pot).toBe(100_000_000n);
    store.clearOpenSeen(newRound);
  });

  it("leaves a fresh round alone (the timeout is not a hair-trigger)", async () => {
    process.env.ROUND_TIMEOUT_MS = "60000";
    const backend = createLocalBackend(cfg, PROGRAM_ID);
    await backend.runLifecycle("create", { tier: 1 });
    await backend.deposit({ roundId: 1n, wallet, lamports: 100_000_000n });

    // Just observed OPEN — the clock starts now, nothing is cancelled.
    await advanceTierLane(1, { backend, cfg });

    expect(backend.ledger.getRound(1n)!.status).toBe("OPEN");
    expect(backend.ledger.receivedBy(wallet)).toBe(0n);
    store.clearOpenSeen(1n);
  });
});
