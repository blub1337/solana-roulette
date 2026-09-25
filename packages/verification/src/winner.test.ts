import { describe, it, expect } from "vitest";
import {
  computeFeeSplit,
  computeTicket,
  deriveRandomness,
  selectWinner,
  resolveWinner,
  WeightMismatchError,
  EmptyRoundError,
  type WeightedEntry,
} from "./winner.js";

function mkEntries(amounts: number[]): WeightedEntry[] {
  let start = 0n;
  return amounts.map((a, i) => {
    const e: WeightedEntry = {
      id: `wallet-${i}`,
      amount: BigInt(a),
      weightStart: start,
      index: i,
    };
    start += BigInt(a);
    return e;
  });
}

describe("selectWinner", () => {
  it("is deterministic", () => {
    const entries = mkEntries([100, 200, 300]);
    expect(selectWinner(entries, 50n).id).toBe(selectWinner(entries, 50n).id);
    expect(selectWinner(entries, 50n).id).toBe("wallet-0");
    expect(selectWinner(entries, 99n).id).toBe("wallet-0");
    expect(selectWinner(entries, 100n).id).toBe("wallet-1");
    expect(selectWinner(entries, 299n).id).toBe("wallet-1");
    expect(selectWinner(entries, 300n).id).toBe("wallet-2");
    expect(selectWinner(entries, 599n).id).toBe("wallet-2");
  });

  it("boundary ticket maps to the NEXT participant (half-open ranges)", () => {
    const entries = mkEntries([100, 100]);
    expect(selectWinner(entries, 100n).id).toBe("wallet-1");
  });

  it("sorts by index regardless of input order", () => {
    const entries = mkEntries([100, 200]);
    const shuffled = [entries[1]!, entries[0]!];
    expect(selectWinner(shuffled, 150n).id).toBe("wallet-1");
  });

  it("throws on broken weight chain", () => {
    const entries = mkEntries([100, 200]);
    entries[1]!.weightStart = 999n;
    expect(() => selectWinner(entries, 5n)).toThrow(WeightMismatchError);
  });

  it("throws when ticket exceeds total weight", () => {
    const entries = mkEntries([100]);
    expect(() => selectWinner(entries, 100n)).toThrow(WeightMismatchError);
  });

  it("throws on empty round", () => {
    expect(() => selectWinner([], 0n)).toThrow(EmptyRoundError);
  });
});

describe("computeFeeSplit", () => {
  it("computes 7.5% fee with floor and 92.5% payout", () => {
    const { fee, payout } = computeFeeSplit(10_000_000_000n, 750);
    expect(fee).toBe(750_000_000n);
    expect(payout).toBe(9_250_000_000n);
    expect(fee + payout).toBe(10_000_000_000n);
  });

  it("floors fractional lamports", () => {
    const { fee, payout } = computeFeeSplit(999n, 750);
    expect(fee).toBe(74n); // 999*750/10000 = 74.925 -> 74
    expect(payout).toBe(925n);
    expect(fee + payout).toBe(999n);
  });

  it("rejects out-of-range fee bps", () => {
    expect(() => computeFeeSplit(1000n, 10_001)).toThrow(WeightMismatchError);
  });
});

describe("deriveRandomness + computeTicket", () => {
  it("produces identical randomness for identical inputs", () => {
    const bh = new Uint8Array(32).fill(7);
    expect(deriveRandomness(bh, 1n)).toEqual(deriveRandomness(bh, 1n));
    expect(deriveRandomness(bh, 1n)).not.toEqual(deriveRandomness(bh, 2n));
  });

  it("ticket is within [0, totalWeight)", () => {
    const bh = new Uint8Array(32).fill(255);
    const r = deriveRandomness(bh, 42n);
    expect(computeTicket(r, 10_000_000_000n) < 10_000_000_000n).toBe(true);
  });
});

// ---- Property-based (seeded pseudo-random; no Math.random in prod code) ----

/** Deterministic xorshift PRNG so test runs are reproducible. */
function mkRng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

describe("property: resolveWinner invariants", () => {
  it("same entropy + participants => same winner, always (200 rounds)", () => {
    const rng = mkRng(12345);
    for (let round = 0; round < 200; round++) {
      const n = 1 + Math.floor(rng() * 12);
      const amounts = Array.from({ length: n }, () => 1 + Math.floor(rng() * 1_000_000));
      const entries = mkEntries(amounts);
      const total = entries.reduce((a, e) => a + e.amount, 0n);
      const entropy = new Uint8Array(32);
      for (let i = 0; i < 32; i++) entropy[i] = Math.floor(rng() * 256);

      const a = resolveWinner(entries, entropy, total);
      const b = resolveWinner(entries, entropy, total);
      expect(a.winner.id).toBe(b.winner.id);
      expect(a.ticket).toBe(b.ticket);
      expect(a.ticket >= 0n && a.ticket < total).toBe(true);
    }
  });

  it("statistical monotonicity: bigger stake never lowers win rate", () => {
    const rng = mkRng(777);
    const wins: number[] = [0, 0];
    const trials = 4000;
    for (let i = 0; i < trials; i++) {
      const amounts = [100, 900]; // small vs big
      const entries = mkEntries(amounts);
      const total = entries.reduce((a, e) => a + e.amount, 0n);
      const entropy = new Uint8Array(32);
      for (let j = 0; j < 32; j++) entropy[j] = Math.floor(rng() * 256);
      const { winner } = resolveWinner(entries, entropy, total);
      wins[winner.index]! += 1;
    }
    // big stake (index 1) should win ~90%
    expect(wins[1]! / trials).toBeGreaterThan(0.85);
    expect(wins[0]! / trials).toBeLessThan(0.15);
  });

  it("weight chain always sums to pot across random rounds", () => {
    const rng = mkRng(999);
    for (let round = 0; round < 100; round++) {
      const n = 1 + Math.floor(rng() * 20);
      const amounts = Array.from({ length: n }, () => 1 + Math.floor(rng() * 5000));
      const entries = mkEntries(amounts);
      const total = entries.reduce((a, e) => a + e.amount, 0n);
      expect(total).toBe(BigInt(amounts.reduce((a, b) => a + b, 0)));
      // last participant's range ends exactly at total
      const last = entries[entries.length - 1]!;
      expect(last.weightStart + last.amount).toBe(total);
    }
  });
});
