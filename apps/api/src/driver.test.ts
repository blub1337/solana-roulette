/**
 * Settlement driver transitions.
 *
 * Pins the corrected state machine. `lock_round` moves FULL ->
 * RANDOMNESS_PENDING and commits the reveal slot, so settle MUST run from
 * RANDOMNESS_PENDING (it previously required FULL, which made settlement
 * unreachable), and pay runs from the same state once the winner is frozen.
 */
import { describe, it, expect, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { advanceTierLane, createGuardedTick } from "./settlement.js";
import type { ChainBackend, LifecycleAction, LifecycleArgs } from "./backend.js";
import type { RoundData, ParticipantData, GlobalConfigData } from "@solana-roulette/verification";
import { resolveConfig } from "@solana-roulette/config";

const TREASURY = new PublicKey("6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR");

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
    feeBps: 750,
    randomness: new Uint8Array(32),
    winningTicket: 0n,
    winner: PublicKey.default,
    feeLamports: 0n,
    payoutLamports: 0n,
    payoutAccount: new Uint8Array(32),
    tier: 0,
    bump: 255,
    ...over,
  };
}

const NO_PARTICIPANTS: ParticipantData[] = [];

interface Harness {
  backend: ChainBackend;
  calls: { action: LifecycleAction; roundId?: bigint; tier?: number }[];
  rounds: Map<string, RoundData>;
  heads: bigint[];
  slot: bigint;
  setRound(r: RoundData): void;
  freezeWinner(): void;
}

function harness(opts: { round?: RoundData; slot?: bigint; heads?: bigint[] } = {}): Harness {
  const round = opts.round ?? makeRound({ status: "OPEN" });
  const rounds = new Map<string, RoundData>([[round.id.toString(), round]]);
  const calls: { action: LifecycleAction; roundId?: bigint; tier?: number }[] = [];
  const heads = opts.heads ?? [1n, 0n, 0n];
  const state = { slot: opts.slot ?? 100n };

  const backend: ChainBackend = {
    mode: "local",
    realFunds: false,
    async getRound(id) {
      return rounds.get(id.toString()) ?? null;
    },
    async getParticipants() {
      return NO_PARTICIPANTS;
    },
    async getGlobalConfig(): Promise<GlobalConfigData | null> {
      return null;
    },
    async getCurrentSlot() {
      return state.slot;
    },
    async getRevealBlockhash() {
      return null;
    },
    async getHeadByTier() {
      return [...heads];
    },
    async runLifecycle(action: LifecycleAction, args: LifecycleArgs = {}) {
      calls.push({ action, roundId: args.roundId, tier: args.tier });
      const id = args.roundId ?? BigInt(rounds.size + 1);
      const r = rounds.get(id.toString());
      if (action === "create") {
        heads[args.tier ?? 0] = id;
        rounds.set(id.toString(), makeRound({ id, tier: args.tier ?? 0 }));
        return { signature: `sig-create-${id}`, roundId: id };
      }
      if (!r) return null;
      if (action === "lock") {
        r.status = "RANDOMNESS_PENDING";
        r.lockSlot = state.slot;
        r.revealSlot = state.slot + 32n;
        return { signature: "sig-lock", roundId: id };
      }
      if (action === "settle") {
        if (r.status !== "RANDOMNESS_PENDING") return null;
        const winner = new PublicKey(new Uint8Array(32).fill(9));
        r.winner = winner;
        r.feeLamports = 20_000_000n;
        r.payoutLamports = 980_000_000n;
        return { signature: "sig-settle", roundId: id, winner: winner.toBase58() };
      }
      if (action === "pay") {
        if (r.status !== "RANDOMNESS_PENDING" || r.winner.equals(PublicKey.default)) return null;
        r.status = "COMPLETED";
        return {
          signature: "sig-pay",
          roundId: id,
          winner: r.winner.toBase58(),
          payoutLamports: r.payoutLamports.toString(),
          feeLamports: r.feeLamports.toString(),
        };
      }
      return null;
    },
    async deposit() {
      throw new Error("not used");
    },
    treasuryAccrued() {
      return 0n;
    },
  };

  return {
    backend,
    calls,
    rounds,
    heads,
    get slot() {
      return state.slot;
    },
    set slot(v: bigint) {
      state.slot = v;
    },
    setRound(r: RoundData) {
      rounds.set(r.id.toString(), r);
    },
    freezeWinner(roundId = "1") {
      const r = rounds.get(roundId)!;
      r.winner = new PublicKey(new Uint8Array(32).fill(9));
      r.feeLamports = 20_000_000n;
      r.payoutLamports = 980_000_000n;
    },
  };
}

const cfg = resolveConfig({ PLATFORM_FEE_WALLET: TREASURY.toBase58() } as NodeJS.ProcessEnv);

describe("settlement driver transitions", () => {
  it("does nothing while the round is OPEN", async () => {
    const h = harness({ round: makeRound({ status: "OPEN" }) });
    await advanceTierLane(0, { backend: h.backend, cfg });
    expect(h.calls).toEqual([]);
  });

  it("locks a FULL round, committing the reveal slot", async () => {
    const h = harness({ round: makeRound({ status: "FULL", pot: 1_000_000_000n }) });
    await advanceTierLane(0, { backend: h.backend, cfg });
    expect(h.calls.map((c) => c.action)).toEqual(["lock"]);
    expect(h.rounds.get("1")!.status).toBe("RANDOMNESS_PENDING");
    expect(h.rounds.get("1")!.revealSlot).toBe(h.slot + 32n);
  });

  it("does not settle before the reveal slot is reached", async () => {
    const h = harness({
      round: makeRound({ status: "RANDOMNESS_PENDING", lockSlot: 10n, revealSlot: 42n }),
      slot: 20n,
    });
    await advanceTierLane(0, { backend: h.backend, cfg });
    expect(h.calls).toEqual([]);
  });

  it("settles from RANDOMNESS_PENDING once the reveal slot is reached", async () => {
    const h = harness({
      round: makeRound({ status: "RANDOMNESS_PENDING", lockSlot: 10n, revealSlot: 42n }),
      slot: 42n,
    });
    await advanceTierLane(0, { backend: h.backend, cfg });
    expect(h.calls.map((c) => c.action)).toEqual(["settle"]);
  });

  it("pays the frozen winner and opens the next round in the same tick", async () => {
    const h = harness({ round: makeRound({ status: "RANDOMNESS_PENDING" }), heads: [1n, 0n, 0n] });
    h.freezeWinner();
    await advanceTierLane(0, { backend: h.backend, cfg });
    expect(h.calls.map((c) => c.action)).toEqual(["pay", "create"]);
    expect(h.calls[1]!.tier).toBe(0);
    expect(h.heads[0]).toBe(2n);
  });

  it("never pays the same round twice", async () => {
    // Round 7 keeps this test independent of the shared store's payout marks.
    const h = harness({ round: makeRound({ id: 7n, status: "RANDOMNESS_PENDING" }), heads: [7n, 0n, 0n] });
    h.freezeWinner("7");
    await advanceTierLane(0, { backend: h.backend, cfg });
    expect(h.calls.map((c) => c.action)).toEqual(["pay", "create"]);

    // Simulate a stale read: the lane head still points at the paid round and
    // the round still looks payable. The store guard must block a second pay.
    h.heads[0] = 7n;
    h.setRound(makeRound({ id: 7n, status: "RANDOMNESS_PENDING" }));
    h.freezeWinner("7");
    const before = h.calls.length;
    await advanceTierLane(0, { backend: h.backend, cfg });
    expect(h.calls.length).toBe(before);
  });

  it("opens a round when the lane is empty or the head is terminal", async () => {
    const h = harness({ round: makeRound({ status: "COMPLETED" }) });
    await advanceTierLane(0, { backend: h.backend, cfg });
    expect(h.calls.map((c) => c.action)).toEqual(["create"]);
    expect(h.calls[0]!.tier).toBe(0);
  });

  it("leaves other tiers' rounds alone", async () => {
    // Head points at a round that belongs to lane 1 while lane 0 ticks.
    const h = harness({ round: makeRound({ id: 2n, tier: 1, status: "FULL" }), heads: [2n, 2n, 0n] });
    await advanceTierLane(0, { backend: h.backend, cfg });
    expect(h.calls).toEqual([]);
  });
});

/**
 * The driver runs on an interval, and a pass is not instantaneous (RPC reads,
 * a reveal-slot wait, a payout broadcast). Overlapping passes each drive the
 * same lane, so two of them can both decide to open the "next round" — leaving
 * two OPEN rounds in one lane with the older one and its pot orphaned — or both
 * start the same payout. The guard makes a pass strictly serial.
 */
describe("settlement tick re-entrancy", () => {
  const deps = { backend: harness({ round: makeRound() }).backend, cfg };

  it("drops a tick that arrives while a pass is still running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = 0;
    const pass = vi.fn(async () => {
      entered += 1;
      await gate;
    });
    const tick = createGuardedTick(deps, pass);

    const first = tick();
    await Promise.resolve(); // the first pass is now in flight
    const second = tick(); // an interval tick lands on top of it
    await Promise.resolve();

    // Exactly one pass may be inside the driver at any time.
    expect(entered).toBe(1);
    expect(await second).toBe(false);
    expect(pass).toHaveBeenCalledTimes(1);

    release();
    expect(await first).toBe(true);
  });

  it("runs again once the previous pass finished", async () => {
    const pass = vi.fn(async () => undefined);
    const tick = createGuardedTick(deps, pass);

    expect(await tick()).toBe(true);
    expect(await tick()).toBe(true);
    expect(pass).toHaveBeenCalledTimes(2);
  });

  it("releases the guard even when a pass throws, so one error cannot stall settlement", async () => {
    const pass = vi.fn(async () => {
      throw new Error("rpc down");
    });
    const tick = createGuardedTick(deps, pass);

    await expect(tick()).rejects.toThrow("rpc down");
    await expect(tick()).rejects.toThrow("rpc down");
    expect(pass).toHaveBeenCalledTimes(2);
  });
});
