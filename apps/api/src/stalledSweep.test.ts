/**
 * Stalled-round sweep.
 *
 * `advanceTierLane` only ever advances a lane's HEAD. A round that was locked
 * and then overtaken by its lane (or orphaned across a restart) stays in
 * RANDOMNESS_PENDING forever, holding its pot in escrow — measured on devnet as
 * rounds 24/25 (docs/DEVNET_LEGACY_STATE.md). `sweepStalledRounds` finds those
 * non-head rounds and finishes them through the SAME settle→pay path as a head,
 * WITHOUT opening a new round for the lane and WITHOUT ever cancelling.
 *
 * These tests pin that behaviour, the safety guards (never touch a head or an
 * active/terminal round), idempotence, and the `runOnce` integration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  DEFAULT_STALLED_SWEEP_MS,
  DEFAULT_STALLED_SWEEP_WINDOW,
  resetStalledSweepClockForTests,
  runOnce,
  stalledSweepIntervalMs,
  stalledSweepWindow,
  sweepStalledRounds,
  type SettlementDriverDeps,
} from "./settlement.js";
import { createLocalBackend, type ChainBackend, type LifecycleAction, type LifecycleArgs } from "./backend.js";
import type { GlobalConfigData, RoundData } from "@solana-roulette/verification";
import type { PayoutOutcome, PayoutService } from "./payout.js";
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
  slot: bigint;
  counter: bigint;
  cancelCalls: number;
}

/**
 * Fake chain that mirrors the program's state machine closely enough for the
 * sweep: `settle` freezes a winner (phase 1), `pay` flips to COMPLETED (phase
 * 2), `create` advances the lane head, `cancel` is counted.
 */
function harness(init: { rounds: RoundData[]; heads: bigint[]; slot?: bigint; counter?: bigint }): Harness {
  const rounds = new Map<string, RoundData>(init.rounds.map((r) => [r.id.toString(), r]));
  const calls: Harness["calls"] = [];
  const h: Harness = {
    calls,
    rounds,
    heads: [...init.heads],
    slot: init.slot ?? 0n,
    counter: init.counter ?? init.rounds.reduce((m, r) => (r.id > m ? r.id : m), 0n),
    cancelCalls: 0,
    backend: {} as ChainBackend,
  };
  let nextId = h.counter + 1n;

  h.backend = {
    mode: "chain",
    realFunds: true,
    async getRound(id) {
      return rounds.get(id.toString()) ?? null;
    },
    async getRounds(ids) {
      const out = new Map<string, RoundData>();
      for (const id of ids) {
        const r = rounds.get(id.toString());
        if (r) out.set(id.toString(), r);
      }
      return out;
    },
    async getParticipants() {
      return [];
    },
    async getGlobalConfig() {
      return { roundCounter: h.counter } as unknown as GlobalConfigData;
    },
    async getCurrentSlot() {
      return h.slot;
    },
    async getRevealBlockhash() {
      return null;
    },
    async getHeadByTier() {
      return [...h.heads];
    },
    async runLifecycle(action: LifecycleAction, args: LifecycleArgs = {}) {
      calls.push({ action, roundId: args.roundId, tier: args.tier });
      if (action === "cancel") {
        h.cancelCalls++;
        return null; // cancel never applies to RANDOMNESS_PENDING on-chain
      }
      if (action === "create") {
        nextId += 1n;
        const created = makeRound({ id: nextId, tier: args.tier ?? 0, status: "OPEN", pot: 0n });
        rounds.set(nextId.toString(), created);
        h.heads[args.tier ?? 0] = nextId;
        return { signature: `sig-create-${nextId}`, roundId: nextId };
      }
      if (action === "settle") {
        const r = rounds.get(args.roundId!.toString());
        if (r) {
          r.winner = new PublicKey(new Uint8Array(32).fill(9));
          r.payoutAccount = r.winner.toBytes();
          r.feeLamports = (r.pot * BigInt(r.feeBps)) / 10_000n;
          r.payoutLamports = r.pot - r.feeLamports;
        }
        return { signature: `sig-settle-${args.roundId}`, roundId: args.roundId! };
      }
      if (action === "pay") {
        const r = rounds.get(args.roundId!.toString());
        if (r) r.status = "COMPLETED";
        return { signature: `sig-pay-${args.roundId}`, roundId: args.roundId! };
      }
      return { signature: `sig-${action}`, roundId: args.roundId ?? 0n };
    },
    async deposit() {
      throw new Error("not used");
    },
    treasuryAccrued() {
      return 0n;
    },
  };
  return h;
}

const cfg = resolveConfig({} as NodeJS.ProcessEnv);
const PROGRAM_ID = new PublicKey("F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos");

let savedHeads: bigint[];
let savedTimeout: string | undefined;
let savedSweep: string | undefined;

beforeEach(() => {
  savedHeads = [...store.currentRoundIdByTier];
  savedTimeout = process.env.ROUND_TIMEOUT_MS;
  savedSweep = process.env.STALLED_SWEEP_MS;
  // Keep the OPEN-round refund valve out of these tests: a handful of OPEN
  // heads are used as lane heads and must not be cancelled mid-run.
  process.env.ROUND_TIMEOUT_MS = "0";
  delete process.env.STALLED_SWEEP_MS;
});

afterEach(() => {
  store.currentRoundIdByTier = [...savedHeads];
  if (savedTimeout === undefined) delete process.env.ROUND_TIMEOUT_MS;
  else process.env.ROUND_TIMEOUT_MS = savedTimeout;
  if (savedSweep === undefined) delete process.env.STALLED_SWEEP_MS;
  else process.env.STALLED_SWEEP_MS = savedSweep;
});

describe("stalled sweep (env parsing)", () => {
  it("defaults the interval and window, and honours overrides", () => {
    delete process.env.STALLED_SWEEP_MS;
    expect(stalledSweepIntervalMs()).toBe(DEFAULT_STALLED_SWEEP_MS);
    process.env.STALLED_SWEEP_MS = "0";
    expect(stalledSweepIntervalMs()).toBe(0);
    process.env.STALLED_SWEEP_MS = "1500";
    expect(stalledSweepIntervalMs()).toBe(1500);
    process.env.STALLED_SWEEP_MS = "nonsense";
    expect(stalledSweepIntervalMs()).toBe(DEFAULT_STALLED_SWEEP_MS);

    delete process.env.STALLED_SWEEP_WINDOW;
    expect(stalledSweepWindow()).toBe(DEFAULT_STALLED_SWEEP_WINDOW);
    process.env.STALLED_SWEEP_WINDOW = "12";
    expect(stalledSweepWindow()).toBe(12);
    process.env.STALLED_SWEEP_WINDOW = "-3";
    expect(stalledSweepWindow()).toBe(DEFAULT_STALLED_SWEEP_WINDOW);
  });
});

describe("stalled sweep — finishing a non-head RANDOMNESS_PENDING round", () => {
  it("settles then pays it, and does NOT open a new round for the lane", async () => {
    const id = 5001n;
    const h = harness({
      rounds: [
        makeRound({ id: 1n, tier: 0, status: "OPEN" }),
        makeRound({ id: 2n, tier: 1, status: "OPEN" }),
        makeRound({ id: 3n, tier: 2, status: "OPEN" }),
        // The stalled orphan: tier 0, but the tier-0 lane head is round 1.
        makeRound({ id, tier: 0, status: "RANDOMNESS_PENDING", pot: 1_000_000_000n, revealSlot: 100n }),
      ],
      heads: [1n, 2n, 3n],
      counter: id,
      slot: 200n,
    });
    const deps: SettlementDriverDeps = { backend: h.backend, cfg };
    const before = [...store.currentRoundIdByTier];

    // Pass 1: reveal slot reached, winner not frozen → settle (phase 1).
    const first = await sweepStalledRounds(deps);
    expect(first.candidates).toBe(1);
    expect(first.settled).toBe(1);
    expect(first.paid).toBe(0);
    expect(h.calls.map((c) => c.action)).toEqual(["settle"]);
    expect(h.rounds.get(id.toString())!.status).toBe("RANDOMNESS_PENDING");
    expect(h.rounds.get(id.toString())!.winner.equals(PublicKey.default)).toBe(false);

    // Pass 2: winner now frozen → pay (phase 2) → COMPLETED.
    const second = await sweepStalledRounds(deps);
    expect(second.candidates).toBe(1);
    expect(second.paid).toBe(1);
    expect(h.calls.map((c) => c.action)).toEqual(["settle", "pay"]);
    expect(h.rounds.get(id.toString())!.status).toBe("COMPLETED");

    // The whole point: no lane advance (no duplicate round) and no cancel.
    expect(h.calls.some((c) => c.action === "create")).toBe(false);
    expect(h.calls.some((c) => c.action === "cancel")).toBe(false);
    expect(h.cancelCalls).toBe(0);
    expect(h.heads).toEqual([1n, 2n, 3n]);
    expect(store.currentRoundIdByTier).toEqual(before);

    // Idempotent: a finished round is no longer a candidate.
    const third = await sweepStalledRounds(deps);
    expect(third.candidates).toBe(0);
    expect(h.calls.map((c) => c.action)).toEqual(["settle", "pay"]);
  });

  it("waits — and does nothing — when the reveal slot has not been reached", async () => {
    const id = 5100n;
    const h = harness({
      rounds: [makeRound({ id, tier: 0, status: "RANDOMNESS_PENDING", pot: 1_000_000_000n, revealSlot: 500n })],
      heads: [1n, 2n, 3n],
      counter: id,
      slot: 200n,
    });

    const report = await sweepStalledRounds({ backend: h.backend, cfg });

    expect(report.candidates).toBe(1);
    expect(report.waiting).toBe(1);
    expect(report.settled).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.rounds.get(id.toString())!.status).toBe("RANDOMNESS_PENDING");
  });

  it("finishes a stalled round through the payout service without opening a round", async () => {
    const id = 5500n;
    const winner = new PublicKey(new Uint8Array(32).fill(7));
    const h = harness({
      rounds: [
        makeRound({
          id,
          tier: 0,
          status: "RANDOMNESS_PENDING",
          pot: 1_000_000_000n,
          revealSlot: 1n,
          winner,
          payoutAccount: winner.toBytes(),
          payoutLamports: 980_000_000n,
          feeLamports: 20_000_000n,
        }),
      ],
      heads: [1n, 2n, 3n],
      counter: id,
      slot: 500n,
    });
    const paid: bigint[] = [];
    const payouts: PayoutService = {
      async ensureRoundPaid(target): Promise<PayoutOutcome> {
        paid.push(target.roundId);
        return {
          status: "CONFIRMED",
          signature: "sig-local-pay",
          winner: target.winner,
          payoutLamports: 980_000_000n,
          feeLamports: 20_000_000n,
          alreadyPaid: false,
        };
      },
    };
    const before = [...store.currentRoundIdByTier];

    const report = await sweepStalledRounds({ backend: h.backend, cfg, payouts });

    expect(report.paid).toBe(1);
    expect(paid).toEqual([id]);
    expect(h.rounds.get(id.toString())!.status).toBe("COMPLETED");
    expect(h.calls.some((c) => c.action === "create")).toBe(false);
    expect(store.currentRoundIdByTier).toEqual(before);
  });
});

describe("stalled sweep — safety guards", () => {
  it("never touches an OPEN, FULL or terminal round", async () => {
    const h = harness({
      rounds: [
        makeRound({ id: 5201n, tier: 0, status: "OPEN", pot: 500_000_000n }),
        makeRound({ id: 5202n, tier: 1, status: "FULL", pot: 1_000_000_000n }),
        makeRound({ id: 5203n, tier: 2, status: "COMPLETED", pot: 0n }),
        makeRound({ id: 5204n, tier: 0, status: "CANCELLED", pot: 0n }),
      ],
      heads: [99n, 98n, 97n],
      counter: 5204n,
      slot: 999n,
    });

    const report = await sweepStalledRounds({ backend: h.backend, cfg });

    expect(report.candidates).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it("skips lane heads — those belong to the head loop", async () => {
    const id = 5300n;
    const h = harness({
      rounds: [makeRound({ id, tier: 0, status: "RANDOMNESS_PENDING", pot: 1_000_000_000n, revealSlot: 1n })],
      heads: [id, 2n, 3n],
      counter: id,
      slot: 500n,
    });

    const report = await sweepStalledRounds({ backend: h.backend, cfg });

    expect(report.candidates).toBe(0);
    expect(report.skippedHeads).toBeGreaterThanOrEqual(1);
    expect(h.calls).toEqual([]);
  });

  it("never calls cancel_round on a stalled RANDOMNESS_PENDING round", async () => {
    const id = 5400n;
    const winner = new PublicKey(new Uint8Array(32).fill(7));
    const h = harness({
      rounds: [
        makeRound({
          id,
          tier: 0,
          status: "RANDOMNESS_PENDING",
          pot: 1_000_000_000n,
          revealSlot: 1n,
          winner,
          payoutAccount: winner.toBytes(),
          payoutLamports: 980_000_000n,
          feeLamports: 20_000_000n,
        }),
      ],
      heads: [1n, 2n, 3n],
      counter: id,
      slot: 500n,
    });

    const report = await sweepStalledRounds({ backend: h.backend, cfg });

    expect(report.paid).toBe(1);
    expect(h.cancelCalls).toBe(0);
    expect(h.calls.some((c) => c.action === "cancel")).toBe(false);
  });

  it("only scans the requested id window", async () => {
    const h = harness({
      rounds: [
        makeRound({ id: 6001n, tier: 0, status: "RANDOMNESS_PENDING", pot: 1_000_000_000n, revealSlot: 1n }),
        makeRound({ id: 6002n, tier: 1, status: "RANDOMNESS_PENDING", pot: 1_000_000_000n, revealSlot: 1n }),
      ],
      heads: [9n, 8n, 7n],
      counter: 6002n,
      slot: 500n,
    });

    const report = await sweepStalledRounds({ backend: h.backend, cfg }, { window: 1 });

    expect(report.scanned).toBe(1);
    expect(report.candidates).toBe(1);
  });

  it("aborts cleanly (and touches nothing) when the batched read fails", async () => {
    const id = 5600n;
    const h = harness({
      rounds: [makeRound({ id, tier: 0, status: "RANDOMNESS_PENDING", pot: 1_000_000_000n, revealSlot: 1n })],
      heads: [1n, 2n, 3n],
      counter: id,
      slot: 500n,
    });
    h.backend.getRounds = async () => {
      throw new Error("rpc down");
    };

    const report = await sweepStalledRounds({ backend: h.backend, cfg });

    expect(report.candidates).toBe(0);
    expect(h.calls).toEqual([]);
  });
});

describe("stalled sweep — runOnce integration", () => {
  it("a full driver pass sweeps a stalled round to COMPLETED across two ticks", async () => {
    process.env.STALLED_SWEEP_MS = "1";
    resetStalledSweepClockForTests();
    const id = 6100n;
    const h = harness({
      rounds: [
        makeRound({ id: 1n, tier: 0, status: "OPEN" }),
        makeRound({ id: 2n, tier: 1, status: "OPEN" }),
        makeRound({ id: 3n, tier: 2, status: "OPEN" }),
        makeRound({ id, tier: 0, status: "RANDOMNESS_PENDING", pot: 1_000_000_000n, revealSlot: 100n }),
      ],
      heads: [1n, 2n, 3n],
      counter: id,
      slot: 200n,
    });
    const deps: SettlementDriverDeps = { backend: h.backend, cfg };

    await runOnce(deps); // sweeps: settle
    resetStalledSweepClockForTests();
    await runOnce(deps); // sweeps: pay

    expect(h.rounds.get(id.toString())!.status).toBe("COMPLETED");
    expect(h.calls.some((c) => c.action === "settle")).toBe(true);
    expect(h.calls.some((c) => c.action === "pay")).toBe(true);
    expect(h.calls.some((c) => c.action === "cancel")).toBe(false);
  });

  it("does not sweep until one interval has elapsed (STALLED_SWEEP_MS=0 disables it)", async () => {
    process.env.STALLED_SWEEP_MS = "0";
    resetStalledSweepClockForTests();
    const id = 6200n;
    const h = harness({
      rounds: [makeRound({ id, tier: 0, status: "RANDOMNESS_PENDING", pot: 1_000_000_000n, revealSlot: 1n })],
      heads: [1n, 2n, 3n],
      counter: id,
      slot: 500n,
    });

    await runOnce({ backend: h.backend, cfg });

    // Disabled: the stalled orphan is left untouched.
    expect(h.calls.some((c) => c.action === "settle" || c.action === "pay")).toBe(false);
    expect(h.rounds.get(id.toString())!.status).toBe("RANDOMNESS_PENDING");
  });
});

/**
 * End-to-end through the REAL devnet ledger (not a fake): the exact user
 * scenario from the review — a round that was locked, then overtaken by its own
 * lane, so the head-driven loop never revisits it. The sweep must finish it and
 * pay the winner, and must NOT advance the lane.
 */
describe("stalled sweep — real devnet ledger, orphaned non-head round", () => {
  it("finishes a round stranded in RANDOMNESS_PENDING and pays its winner", async () => {
    vi.useFakeTimers();
    try {
      const backend = createLocalBackend(cfg, PROGRAM_ID);
      const wallet = new PublicKey(new Uint8Array(32).fill(7));

      // Round #1 (tier 0) fills to its cap and locks → RANDOMNESS_PENDING.
      await backend.runLifecycle("create", { tier: 0 });
      await backend.deposit({ roundId: 1n, wallet, lamports: 1_000_000_000n });
      expect(backend.ledger.getRound(1n)!.status).toBe("FULL");
      await backend.runLifecycle("lock", { roundId: 1n });
      expect(backend.ledger.getRound(1n)!.status).toBe("RANDOMNESS_PENDING");

      // The lane then advances to round #2 → round #1 is a non-head orphan
      // that advanceTierLane can never revisit.
      await backend.runLifecycle("create", { tier: 0 });
      expect(backend.ledger.headByTier[0]).toBe(2n);

      // Move the virtual clock past round #1's committed reveal slot.
      vi.advanceTimersByTime(60_000);

      const deps: SettlementDriverDeps = { backend, cfg };

      const first = await sweepStalledRounds(deps);
      expect(first.candidates).toBe(1);
      expect(first.settled).toBe(1);

      const second = await sweepStalledRounds(deps);
      expect(second.paid).toBe(1);

      // Finished and paid exactly: the winner got pot − 2 % fee.
      expect(backend.ledger.getRound(1n)!.status).toBe("COMPLETED");
      expect(backend.ledger.receivedBy(wallet)).toBe(980_000_000n);
      expect(backend.treasuryAccrued()).toBe(20_000_000n);

      // The orphan lane did NOT advance: round #2 is still the tier-0 head.
      expect(backend.ledger.headByTier[0]).toBe(2n);
      expect(backend.ledger.getRound(2n)!.status).toBe("OPEN");
    } finally {
      vi.useRealTimers();
    }
  });
});
