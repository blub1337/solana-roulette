import { describe, it, expect } from "vitest";
import { resolveConfig, MainnetDisabledError, assertNetworkAllowsTransactions } from "./index.js";

/**
 * Strip every env key resolveConfig reads so the fixture tests the actual
 * defaults — otherwise the test inherits values from the host environment
 * (e.g. a workspace sets PLATFORM_FEE_BPS=750 and the 200-bps default test
 * fails even though the override mechanism itself works correctly).
 */
const CONFIG_ENV_KEYS = [
  "SOLANA_NETWORK",
  "ENABLE_MAINNET",
  "PLATFORM_FEE_BPS",
  "POOL_TARGET_SOL",
  "SOLANA_RPC_URL",
  "ROULETTE_PROGRAM_ID",
  "OPERATOR_KEYPAIR",
  "ADMIN_TOKEN",
  "DEPOSITS_PAUSED",
  "PLATFORM_FEE_WALLET",
  "TREASURY_PUBKEY",
  "DEPOSIT_ESCROW_WALLET",
  "MAX_ROUND_SIZE_LAMPORTS",
  "MIN_DEPOSIT_LAMPORTS",
  "MAX_DEPOSIT_LAMPORTS",
  "TIER_CAPS_SOL",
  "REVEAL_OFFSET_SLOTS",
] as const;

const BASE_ENV = { ...process.env } as NodeJS.ProcessEnv;
for (const key of CONFIG_ENV_KEYS) delete BASE_ENV[key];

describe("resolveConfig", () => {
  it("defaults to devnet with a 100-SOL ceiling and the 200-bps commission", () => {
    const cfg = resolveConfig(BASE_ENV);
    expect(cfg.network).toBe("devnet");
    expect(cfg.feeBps).toBe(200);
    expect(cfg.maxRoundSizeLamports).toBe(100_000_000_000n);
    expect(cfg.revealOffsetSlots).toBe(32);
  });

  it("defaults PLATFORM_FEE_BPS to 200 — the target rate seeded on-chain and shown in the UI", () => {
    // Priority-4 unification: the env default, the on-chain seed rate and the
    // documented split (98% / 2%) must all be the SAME number, so no
    // environment can silently boot with a commission players were never told
    // about. The effective value is still resolved per environment by
    // feeTerms.ts (chain mode reads GlobalConfig).
    const cfg = resolveConfig(BASE_ENV);
    expect(cfg.platformFeeBps).toBe(200);
    expect(cfg.feeBps).toBe(200);
  });

  it("mainnet-beta without ENABLE_MAINNET throws MAINNET_DISABLED", () => {
    expect(() => resolveConfig({ ...BASE_ENV, SOLANA_NETWORK: "mainnet-beta" })).toThrow(
      MainnetDisabledError
    );
  });

  it("mainnet-beta with ENABLE_MAINNET=true is allowed", () => {
    const cfg = resolveConfig({
      ...BASE_ENV,
      SOLANA_NETWORK: "mainnet-beta",
      ENABLE_MAINNET: "true",
    });
    expect(cfg.network).toBe("mainnet-beta");
    expect(cfg.mainnetEnabled).toBe(true);
  });

  it("ENABLE_MAINNET alone does NOT enable mainnet", () => {
    const cfg = resolveConfig({ ...BASE_ENV, ENABLE_MAINNET: "true" });
    expect(cfg.network).toBe("devnet");
    expect(cfg.mainnetEnabled).toBe(true);
    // assert passes for devnet regardless
    expect(() => assertNetworkAllowsTransactions(cfg)).not.toThrow();
  });

  it("rejects invalid network names", () => {
    expect(() => resolveConfig({ ...BASE_ENV, SOLANA_NETWORK: "bosnet" })).toThrow(/SOLANA_NETWORK/);
  });

  it("rejects non-numeric lamport env", () => {
    expect(() =>
      resolveConfig({ ...BASE_ENV, MAX_ROUND_SIZE_LAMPORTS: "ten-sol" })
    ).toThrow(/must be an integer/);
  });

  it("accepts underscore-separated lamport values", () => {
    const cfg = resolveConfig({ ...BASE_ENV, MAX_ROUND_SIZE_LAMPORTS: "100_000_000_000" });
    expect(cfg.maxRoundSizeLamports).toBe(100_000_000_000n);
  });

  it("exposes platform fee wallet, bps and pool target", () => {
    const cfg = resolveConfig({
      ...BASE_ENV,
      PLATFORM_FEE_WALLET: "6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR",
      PLATFORM_FEE_BPS: "200",
      POOL_TARGET_SOL: "10",
    });
    expect(cfg.platformFeeWallet).toBe("6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR");
    expect(cfg.platformFeeBps).toBe(200);
    expect(cfg.poolTargetLamports).toBe(10_000_000_000n);
  });

  it("rejects non-numeric POOL_TARGET_SOL", () => {
    expect(() => resolveConfig({ ...BASE_ENV, POOL_TARGET_SOL: "ten" })).toThrow(/POOL_TARGET_SOL/);
  });

  it("parses POOL_TARGET_SOL to EXACT lamports (9 decimals, no float drift)", () => {
    // 1234567891 nanos — Number math (x * 1e9) drifts ±1 lamport on inputs
    // like this; the decimal-string parser must not.
    const cfg = resolveConfig({ ...BASE_ENV, POOL_TARGET_SOL: "1.234567891" });
    expect(cfg.poolTargetLamports).toBe(1_234_567_891n);
  });

  it("defaults MAX_ROUND_SIZE_LAMPORTS to cover the largest tier cap (100 SOL)", () => {
    const cfg = resolveConfig(BASE_ENV);
    expect(cfg.maxRoundSizeLamports).toBe(100_000_000_000n);
    const maxCap = cfg.tierCapsLamports.reduce((m, c) => (c > m ? c : m), 0n);
    expect(maxCap <= cfg.maxRoundSizeLamports).toBe(true);
  });

  it("refuses a MAX_ROUND_SIZE below a tier cap — that lane could never fill or settle", () => {
    // With default caps (1/10/100 SOL) a 10-SOL ceiling strands the 100-SOL
    // lane: deposits are capped by BOTH limits, auto-close fires only at
    // pot == tier_cap, so the round never closes. This used to be the silent
    // default (10 SOL) with TIER_CAPS_SOL=1,10,100 shipped.
    expect(() =>
      resolveConfig({ ...BASE_ENV, MAX_ROUND_SIZE_LAMPORTS: "10000000000" })
    ).toThrow(/MAX_ROUND_SIZE_LAMPORTS/);
  });

  it("accepts MAX_ROUND_SIZE exactly equal to the largest tier cap", () => {
    const cfg = resolveConfig({ ...BASE_ENV, MAX_ROUND_SIZE_LAMPORTS: "100000000000" });
    expect(cfg.maxRoundSizeLamports).toBe(100_000_000_000n);
  });
});
