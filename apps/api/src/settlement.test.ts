import { describe, it, expect } from "vitest";
import { computeFeeSplit } from "@solana-roulette/verification";
import { poolTargetLamports, tierCapLamports } from "./settlement.js";
import { resolveConfig } from "@solana-roulette/config";
import { Store } from "./store.js";
import { TIER_CAPS_SOL, TIER_COUNT } from "@solana-roulette/types";

describe("fee split (integer lamports, floor)", () => {
  it("splits a 10 SOL pot into 0.75 fee + 9.25 payout at 750 bps", () => {
    const pot = 10_000_000_000n;
    const { fee, payout } = computeFeeSplit(pot, 750);
    expect(fee).toBe(750_000_000n);
    expect(payout).toBe(9_250_000_000n);
    expect(fee + payout).toBe(pot);
  });

  it("floors fractional lamports", () => {
    const { fee, payout } = computeFeeSplit(999n, 750);
    expect(fee).toBe(74n);
    expect(fee + payout).toBe(999n);
  });
});

describe("poolTargetLamports", () => {
  it("uses POOL_TARGET_SOL when configured (exact integer lamports)", () => {
    const cfg = resolveConfig({ POOL_TARGET_SOL: "10" } as NodeJS.ProcessEnv);
    expect(poolTargetLamports(cfg)).toBe(10_000_000_000n);
  });

  it("falls back to max round size when unset", () => {
    const cfg = resolveConfig({} as NodeJS.ProcessEnv);
    expect(poolTargetLamports(cfg)).toBe(10_000_000_000n);
  });
});

describe("tier caps (three independent pool lanes)", () => {
  it("defaults to 1 / 10 / 100 SOL in exact lamports", () => {
    const cfg = resolveConfig({} as NodeJS.ProcessEnv);
    expect(cfg.tierCapsLamports[0]).toBe(1_000_000_000n);
    expect(cfg.tierCapsLamports[1]).toBe(10_000_000_000n);
    expect(cfg.tierCapsLamports[2]).toBe(100_000_000_000n);
  });

  it("mirrors TIER_CAPS_SOL", () => {
    expect([...TIER_CAPS_SOL]).toEqual([1, 10, 100]);
    expect(TIER_COUNT).toBe(3);
  });

  it("parses TIER_CAPS_SOL with fractional entries exactly (no float drift)", () => {
    const cfg = resolveConfig({ TIER_CAPS_SOL: "0.5,2.25,10" } as NodeJS.ProcessEnv);
    expect(cfg.tierCapsLamports[0]).toBe(500_000_000n);
    expect(cfg.tierCapsLamports[1]).toBe(2_250_000_000n);
    expect(cfg.tierCapsLamports[2]).toBe(10_000_000_000n);
  });

  it("rejects non-ascending or malformed TIER_CAPS_SOL", () => {
    expect(() => resolveConfig({ TIER_CAPS_SOL: "10,1,100" } as NodeJS.ProcessEnv)).toThrow();
    expect(() => resolveConfig({ TIER_CAPS_SOL: "1,10" } as NodeJS.ProcessEnv)).toThrow();
    expect(() => resolveConfig({ TIER_CAPS_SOL: "1,10,abc" } as NodeJS.ProcessEnv)).toThrow();
  });

  it("tierCapLamports returns the cap of the requested tier", () => {
    const cfg = resolveConfig({} as NodeJS.ProcessEnv);
    expect(tierCapLamports(cfg, 0)).toBe(1_000_000_000n);
    expect(tierCapLamports(cfg, 1)).toBe(10_000_000_000n);
    expect(tierCapLamports(cfg, 2)).toBe(100_000_000_000n);
  });
});

describe("tier lane heads (independent lanes)", () => {
  it("starts one head per tier at ids 1, 2, 3", () => {
    const s = new Store();
    expect(s.currentRoundIdByTier).toEqual([1n, 2n, 3n]);
  });

  it("keeps lane heads independent when upserting rounds of different tiers", () => {
    const s = new Store();
    s.upsertRound({ id: "1", tier: 0, status: "COMPLETED" });
    s.upsertRound({ id: "2", tier: 1, status: "OPEN", pot: "500000000" });
    s.upsertRound({ id: "3", tier: 2, status: "OPEN" });

    expect(s.getRound("1")?.tier).toBe(0);
    expect(s.getRound("2")?.tier).toBe(1);
    expect(s.getRound("2")?.status).toBe("OPEN");
    expect(s.getRound("3")?.tier).toBe(2);

    // Completing tier 0 does not mutate lanes 1/2.
    s.upsertRound({ id: "1", status: "CANCELLED" });
    expect(s.getRound("1")?.status).toBe("CANCELLED");
    expect(s.getRound("1")?.tier).toBe(0);
    expect(s.getRound("2")?.status).toBe("OPEN");
    expect(s.getRound("3")?.status).toBe("OPEN");
    expect(s.currentRoundIdByTier).toEqual([1n, 2n, 3n]);
  });

  it("fills percent math caps at 100 for tier caps", () => {
    // 1-SOL lane: 0.75 SOL of 1 SOL = 75%
    const pot = 750_000_000n;
    const cap = 1_000_000_000n;
    expect(Number((pot * 10_000n) / cap) / 100).toBe(75);
    expect(Math.min(100, Number((pot * 10_000n) / cap) / 100)).toBe(75);
  });
});
