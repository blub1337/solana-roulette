import { describe, it, expect } from "vitest";
import { resolveConfig, MainnetDisabledError, assertNetworkAllowsTransactions } from "./index.js";

const BASE_ENV = { ...process.env } as NodeJS.ProcessEnv;
delete BASE_ENV.SOLANA_NETWORK;
delete BASE_ENV.ENABLE_MAINNET;

describe("resolveConfig", () => {
  it("defaults to devnet with 10 SOL cap and 750 bps", () => {
    const cfg = resolveConfig(BASE_ENV);
    expect(cfg.network).toBe("devnet");
    expect(cfg.feeBps).toBe(750);
    expect(cfg.maxRoundSizeLamports).toBe(10_000_000_000n);
    expect(cfg.revealOffsetSlots).toBe(32);
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
    const cfg = resolveConfig({ ...BASE_ENV, MAX_ROUND_SIZE_LAMPORTS: "10_000_000_000" });
    expect(cfg.maxRoundSizeLamports).toBe(10_000_000_000n);
  });

  it("exposes platform fee wallet, bps and pool target", () => {
    const cfg = resolveConfig({
      ...BASE_ENV,
      PLATFORM_FEE_WALLET: "6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR",
      PLATFORM_FEE_BPS: "750",
      POOL_TARGET_SOL: "10",
    });
    expect(cfg.platformFeeWallet).toBe("6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR");
    expect(cfg.platformFeeBps).toBe(750);
    expect(cfg.poolTargetSol).toBe(10);
  });

  it("rejects non-numeric POOL_TARGET_SOL", () => {
    expect(() => resolveConfig({ ...BASE_ENV, POOL_TARGET_SOL: "ten" })).toThrow(/POOL_TARGET_SOL/);
  });
});
