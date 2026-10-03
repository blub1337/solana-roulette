import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import type { GlobalConfigData, RoundData } from "@solana-roulette/verification";
import {
  rehydrateLaneHeads,
  advanceTierLane,
  LANE_SCAN_LIMIT,
  MAX_SCAN_WINDOWS,
  type SettlementDriverDeps,
} from "./settlement.js";
import type { ChainBackend, LifecycleAction, LifecycleArgs, LifecycleResult } from "./backend.js";
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
    ...over,
  };
}

/**
 * Fake chain backend backed by an explicit round map + counter, so tests can
 * lay out any on-chain world (including the pre-fix duplicate) exactly.
 */
function fakeBackend(rounds: Map<string, RoundData>, counter: bigint): ChainBackend {
  return {
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
    async getGlobalConfig(): Promise<GlobalConfigData | null> {
      // Shape is irrelevant here beyond roundCounter; cast through unknown.
      return { roundCounter: counter } as unknown as GlobalConfigData;
    },
    async getCurrentSlot() {
      return 10_000n;
    },
    async getRevealBlockhash() {
      return null;
    },
    async getHeadByTier() {
      return [...store.currentRoundIdByTier];
    },
    async runLifecycle(_action: LifecycleAction, _args?: LifecycleArgs) {
      return null;
    },
    async deposit(args) {
      return { signature: "", roundId: args.roundId };
    },
    treasuryAccrued() {
      return 0n;
    },
  };
}

const deps = (rounds: Map<string, RoundData>, counter: bigint): SettlementDriverDeps => ({
  backend: fakeBackend(rounds, counter),
  cfg: { platformFeeWallet: "6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR" },
} as unknown as SettlementDriverDeps);

/** Boot as if the process just restarted: heads at their defaults. */
function boot(heads: bigint[] = [1n, 2n, 3n]): void {
  store.currentRoundIdByTier = [...heads];
}

describe("rehydrateLaneHeads", () => {
  it("adopts the newest round per tier after a restart (the core P0 repair)", async () => {
    // Chain world: counter 91, tier 0 head = 90, tier 1 head = 87, tier 2 = 3.
    const rounds = new Map<string, RoundData>();
    for (const id of [90n, 87n, 3n]) {
      const tier = id === 90n ? 0 : id === 87n ? 1 : 2;
      rounds.set(id.toString(), makeRound({ id, tier, status: "OPEN" }));
    }
    // Historical tier-0 rounds fill the world below; 91 is a not-yet-observed
    // gap (counter=91 means it was created, the scan simply treats a missing
    // account as a gap and keeps walking).
    for (let id = 89n; id >= 1n; id--) {
      if (!rounds.has(id.toString())) rounds.set(id.toString(), makeRound({ id, tier: 0, status: "COMPLETED" }));
    }
    boot();

    const report = await rehydrateLaneHeads(deps(rounds, 91n));
    expect(report.counter).toBe(91n);
    expect(report.restored).toBe(3);
    expect(store.currentRoundIdByTier).toEqual([90n, 87n, 3n]);
  });

  it("chains windows downward when a quiet lane's head sits below the first window", async () => {
    const rounds = new Map<string, RoundData>();
    for (let id = 250n; id >= 1n; id--) {
      rounds.set(id.toString(), makeRound({ id, tier: 0, status: "COMPLETED" }));
    }
    // Tier 2's newest round is id 5 — 245 ids below the counter, outside the
    // first window but inside the second.
    rounds.set("5", makeRound({ id: 5n, tier: 2, status: "OPEN" }));
    boot();

    const report = await rehydrateLaneHeads(deps(rounds, 250n));
    expect(store.currentRoundIdByTier[2]).toBe(5n);
    expect(report.restored).toBeGreaterThanOrEqual(1);
  });

  it("does not adopt a legacy (pre-reveal_input) round as a lane head", async () => {
    const rounds = new Map<string, RoundData>();
    for (let id = 100n; id >= 1n; id--) {
      rounds.set(id.toString(), makeRound({ id, tier: 0, status: "COMPLETED" }));
    }
    // The genesis tier-1 / tier-2 rounds predate the appended `reveal_input`
    // field: the deployed program cannot deserialize them, so every deposit
    // reverts with AccountDidNotDeserialize (3003). They must NOT be adopted.
    rounds.set("2", makeRound({ id: 2n, tier: 1, status: "OPEN", legacy: true }));
    rounds.set("3", makeRound({ id: 3n, tier: 2, status: "OPEN", legacy: true }));
    boot();

    await rehydrateLaneHeads(deps(rounds, 100n));
    expect(store.currentRoundIdByTier[0]).toBe(100n);
    // Left at the boot default; the driver then opens a fresh round instead.
    expect(store.currentRoundIdByTier[1]).toBe(2n);
    expect(store.currentRoundIdByTier[2]).toBe(3n);
  });

  it("leaves a lane at its boot default when no round of that tier exists in the scan", async () => {
    const rounds = new Map<string, RoundData>();
    for (let id = 100n; id >= 1n; id--) {
      rounds.set(id.toString(), makeRound({ id, tier: 0, status: "COMPLETED" }));
    }
    boot();

    await rehydrateLaneHeads(deps(rounds, 100n));
    // Tier 0 head restored; tiers 1/2 have no rounds → untouched.
    expect(store.currentRoundIdByTier[0]).toBe(100n);
    expect(store.currentRoundIdByTier[1]).toBe(2n);
    expect(store.currentRoundIdByTier[2]).toBe(3n);
  });

  it("never adopts a duplicate round parked in the wrong lane (tier discipline)", async () => {
    // The pre-fix world: duplicate round 91 was created while lane 1's head
    // was stale, so id 91 carries tier 0 but sits ABOVE lane 1's real head.
    const rounds = new Map<string, RoundData>();
    for (let id = 90n; id >= 1n; id--) {
      const tier = id === 87n ? 1 : 0;
      rounds.set(id.toString(), makeRound({ id, tier, status: "COMPLETED" }));
    }
    rounds.set("91", makeRound({ id: 91n, tier: 0, status: "OPEN" }));
    boot();

    await rehydrateLaneHeads(deps(rounds, 91n));
    // Tier 0 takes the newest of its own tier (91). Tier 1 takes 87, NOT 91.
    expect(store.currentRoundIdByTier[0]).toBe(91n);
    expect(store.currentRoundIdByTier[1]).toBe(87n);
  });

  it("ignores nonexistent ids instead of treating gaps as heads", async () => {
    const rounds = new Map<string, RoundData>();
    for (const id of [50n, 40n]) {
      rounds.set(id.toString(), makeRound({ id, tier: 0, status: "OPEN" }));
    }
    boot();

    await rehydrateLaneHeads(deps(rounds, 100n));
    expect(store.currentRoundIdByTier[0]).toBe(50n);
  });

  it("degrades to boot defaults when the RPC read throws (never throws itself)", async () => {
    const failing: ChainBackend = {
      ...fakeBackend(new Map(), 10n),
      async getRounds() {
        throw new Error("429 too many requests");
      },
    };
    boot();
    const report = await rehydrateLaneHeads({ backend: failing } as unknown as SettlementDriverDeps);
    expect(report.restored).toBe(0);
    expect(store.currentRoundIdByTier).toEqual([1n, 2n, 3n]);
  });
});

describe("setLaneHead validation", () => {
  it("accepts a legitimate forward head move", () => {
    boot();
    expect(store.setLaneHead(0, 90n)).toBe(true);
    expect(store.currentRoundIdByTier[0]).toBe(90n);
  });

  it("rejects a head below the boot default (heads only move forward)", () => {
    boot();
    expect(store.setLaneHead(1, 1n)).toBe(false); // boot default for tier 1 is 2
    expect(store.currentRoundIdByTier[1]).toBe(2n);
  });

  it("rejects out-of-lane and non-integer tiers", () => {
    boot();
    expect(store.setLaneHead(3, 10n)).toBe(false);
    expect(store.setLaneHead(-1, 10n)).toBe(false);
    expect(store.setLaneHead(1.5, 10n)).toBe(false);
  });

  it("reports already-correct values as written without mutating", () => {
    boot();
    expect(store.setLaneHead(2, 3n)).toBe(true); // boot default for tier 2 is 3
    expect(store.currentRoundIdByTier[2]).toBe(3n);
  });
});

describe("driver integration with rehydrated heads", () => {
  it("does NOT open a duplicate when the head is another tier's round", async () => {
    const rounds = new Map<string, RoundData>();
    // Head of lane 0 points at round 87 (tier 1) — the stale pre-fix state.
    rounds.set("87", makeRound({ id: 87n, tier: 1, status: "COMPLETED" }));
    // Lane 0's true head: an OPEN round at 90.
    rounds.set("90", makeRound({ id: 90n, tier: 0, status: "OPEN" }));
    boot([87n, 2n, 3n]);

    const harnessDeps = deps(rounds, 91n);
    await advanceTierLane(0, harnessDeps);
    // The lane adopted its true head; no "create" lifecycle was issued.
    expect(store.currentRoundIdByTier[0]).toBe(90n);
  });

  it("advances a rehydrated OPEN lane normally (no create issued)", async () => {
    const rounds = new Map<string, RoundData>();
    rounds.set("90", makeRound({ id: 90n, tier: 0, status: "OPEN", pot: 100n }));
    boot([90n, 2n, 3n]);

    const calls: { action: LifecycleAction; roundId?: bigint; tier?: number }[] = [];
    const backend: ChainBackend = {
      ...fakeBackend(rounds, 91n),
      async runLifecycle(action: LifecycleAction, args?: LifecycleArgs) {
        calls.push({ action, roundId: args?.roundId, tier: args?.tier });
        return null;
      },
    };
    await advanceTierLane(0, { backend, cfg: {} } as unknown as SettlementDriverDeps);
    expect(calls).toEqual([]); // an OPEN round with room left: nothing to do
  });

  it("reopens a lane pinned to a legacy round instead of leaving it unusable", async () => {
    const rounds = new Map<string, RoundData>();
    rounds.set("2", makeRound({ id: 2n, tier: 1, status: "OPEN", legacy: true }));
    boot([100n, 2n, 3n]);

    const calls: { action: LifecycleAction; tier?: number; roundId?: bigint }[] = [];
    const backend: ChainBackend = {
      ...fakeBackend(rounds, 147n),
      async runLifecycle(action: LifecycleAction, args?: LifecycleArgs) {
        calls.push({ action, tier: args?.tier, roundId: args?.roundId });
        return { signature: "sig", roundId: 147n } as unknown as LifecycleResult;
      },
    };
    await advanceTierLane(1, { backend, cfg: {} } as unknown as SettlementDriverDeps);

    // A fresh current-layout round is opened for the lane and adopted.
    expect(calls).toEqual([{ action: "create", tier: 1, roundId: undefined }]);
    expect(store.currentRoundIdByTier[1]).toBe(147n);
  });

  it("exposes the scan knobs for tuning", () => {
    expect(LANE_SCAN_LIMIT).toBeGreaterThan(0);
    expect(MAX_SCAN_WINDOWS).toBeGreaterThan(0);
  });
});
