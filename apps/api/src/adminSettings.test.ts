/**
 * OFF-CHAIN OPERATOR SETTINGS — the soft caps the operator can change without
 * touching the program.
 *
 * These tests pin the two things that make the feature safe:
 *   1. validation — an off-chain override may only TIGHTEN the on-chain bounds,
 *      so a deposit the API accepts is always one the program accepts as well,
 *   2. resolution — a null override falls through to the on-chain value, and a
 *      per-user cap of 0 means "no cap".
 *
 * The persistence side (the audit mirror) is inert under Vitest, so these run
 * against the in-memory singleton; `hydrateGameSettings` is exercised with a
 * spied mirror.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { postgresMirror } from "./store.js";
import {
  applyGameSettingsInput,
  effectiveMaxDeposit,
  effectiveMinDeposit,
  getGameSettings,
  hydrateGameSettings,
  initGameSettings,
  resetGameSettingsForTests,
  SettingsError,
  userCapForTier,
  type SettingsBounds,
} from "./adminSettings.js";

const SOL = 1_000_000_000n;

/** The devnet config the operator console reads: 0.01 SOL … 1 SOL, 1/10/100. */
const BOUNDS: SettingsBounds = {
  onChainMinDepositLamports: 10_000_000n,
  onChainMaxDepositLamports: 1_000_000_000n,
  tierCapsLamports: [1n * SOL, 10n * SOL, 100n * SOL],
};

function expectSettingsError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SettingsError);
    expect((err as SettingsError).code).toBe(code);
    return;
  }
  throw new Error(`expected SettingsError(${code}) but nothing was thrown`);
}

beforeEach(() => {
  initGameSettings();
});

afterEach(() => {
  resetGameSettingsForTests();
});

describe("game settings defaults", () => {
  it("starts with no caps and no overrides", () => {
    const s = getGameSettings();
    expect(s.userCapLamportsByTier).toEqual(["0", "0", "0"]);
    expect(s.minDepositLamports).toBeNull();
    expect(s.maxDepositLamports).toBeNull();
  });

  it("falls back to the on-chain bounds when no override is set", () => {
    const cfg = { minDepositLamports: 10_000_000n, maxDepositLamports: 1_000_000_000n };
    expect(effectiveMinDeposit(cfg)).toBe(10_000_000n);
    expect(effectiveMaxDeposit(cfg)).toBe(1_000_000_000n);
  });

  it("resolves a per-user cap of 0 as 'no cap'", () => {
    for (const tier of [0, 1, 2]) expect(userCapForTier(tier)).toBe(0n);
  });
});

describe("applying operator settings", () => {
  it("stores per-user caps within the lane pool cap and disables with 0", () => {
    const next = applyGameSettingsInput(
      { userCapLamportsByTier: [0, "2000000000", "0"] },
      BOUNDS,
      "tester"
    );
    expect(next.userCapLamportsByTier).toEqual(["0", "2000000000", "0"]);
    expect(userCapForTier(0)).toBe(0n);
    expect(userCapForTier(1)).toBe(2_000_000_000n);
    // The cap may equal the pool cap exactly — only exceeding it is rejected.
    const atCap = applyGameSettingsInput({ userCapLamportsByTier: ["1000000000", "0", "0"] }, BOUNDS);
    expect(atCap.userCapLamportsByTier[0]).toBe("1000000000");
  });

  it("rejects a per-user cap above the lane pool cap", () => {
    expectSettingsError(
      () => applyGameSettingsInput({ userCapLamportsByTier: ["1000000001", "0", "0"] }, BOUNDS),
      "user_cap_above_pool"
    );
  });

  it("rejects a malformed user-cap array or a non-numeric value", () => {
    expectSettingsError(() => applyGameSettingsInput({ userCapLamportsByTier: [1, 2] }, BOUNDS), "invalid_user_caps");
    expectSettingsError(
      () => applyGameSettingsInput({ userCapLamportsByTier: ["1", "2", "nope"] }, BOUNDS),
      "invalid_userCapLamportsByTier[2]"
    );
  });

  it("clamps deposit overrides to the on-chain window", () => {
    expectSettingsError(
      () => applyGameSettingsInput({ minDepositLamports: "5000000" }, BOUNDS),
      "min_below_onchain"
    );
    expectSettingsError(
      () => applyGameSettingsInput({ maxDepositLamports: "2000000000" }, BOUNDS),
      "max_above_onchain"
    );
    // A min above the on-chain min but at/below the on-chain max is fine.
    const tightened = applyGameSettingsInput({ minDepositLamports: "500000000" }, BOUNDS);
    expect(tightened.minDepositLamports).toBe("500000000");
  });

  it("rejects an effective min above the effective max", () => {
    expectSettingsError(
      () =>
        applyGameSettingsInput(
          { minDepositLamports: "500000000", maxDepositLamports: "100000000" },
          BOUNDS
        ),
      "min_above_max"
    );
  });

  it("clears an override with null so the on-chain value applies again", () => {
    applyGameSettingsInput({ minDepositLamports: "500000000", maxDepositLamports: "600000000" }, BOUNDS);
    const cleared = applyGameSettingsInput({ minDepositLamports: null, maxDepositLamports: "" }, BOUNDS);
    expect(cleared.minDepositLamports).toBeNull();
    expect(cleared.maxDepositLamports).toBeNull();
    const cfg = { minDepositLamports: 10_000_000n, maxDepositLamports: 1_000_000_000n };
    expect(effectiveMinDeposit(cfg)).toBe(10_000_000n);
    expect(effectiveMaxDeposit(cfg)).toBe(1_000_000_000n);
  });

  it("records who changed it and when", () => {
    const next = applyGameSettingsInput({ userCapLamportsByTier: ["0", "0", "0"] }, BOUNDS, "operator-7");
    expect(next.updatedBy).toBe("operator-7");
    expect(Number.isNaN(Date.parse(next.updatedAt))).toBe(false);
  });
});

describe("hydrating settings from the audit mirror", () => {
  it("restores a persisted blob", async () => {
    const spy = vi.spyOn(postgresMirror, "readGameSettings").mockResolvedValue(
      JSON.stringify({
        userCapLamportsByTier: ["1000000000", "0", "0"],
        minDepositLamports: "200000000",
        maxDepositLamports: "900000000",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })
    );
    try {
      const restored = await hydrateGameSettings();
      expect(restored.userCapLamportsByTier).toEqual(["1000000000", "0", "0"]);
      expect(restored.minDepositLamports).toBe("200000000");
      expect(restored.maxDepositLamports).toBe("900000000");
      expect(restored.updatedBy).toBe("database");
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps the in-memory default when the mirror read fails", async () => {
    const spy = vi.spyOn(postgresMirror, "readGameSettings").mockRejectedValue(new Error("db down"));
    try {
      const after = await hydrateGameSettings();
      expect(after.userCapLamportsByTier).toEqual(["0", "0", "0"]);
      expect(after.minDepositLamports).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
