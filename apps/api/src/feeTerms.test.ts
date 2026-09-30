/**
 * The fee the API reports must be the fee the runtime charges.
 *
 * These are regression tests for the drift that made the page disagree with
 * the payout: a hardcoded percentage in the UI, and an API that reported
 * `PLATFORM_FEE_BPS` even in chain mode, where the on-chain GlobalConfig
 * (frozen into every round at lock) is what actually decides the split.
 */
import { describe, it, expect, vi } from "vitest";
import type { ChainBackend } from "./backend.js";
import { createFeeResolver, FEE_CACHE_TTL_MS } from "./feeTerms.js";
import { resolveConfig, type AppConfig } from "@solana-roulette/config";
import type { GlobalConfigData } from "@solana-roulette/verification";

const SOLANA_ENV_KEYS = [
  "PLATFORM_FEE_BPS",
  "PLATFORM_FEE_WALLET",
  "TREASURY_PUBKEY",
  "TIER_CAPS_SOL",
  "SOLANA_NETWORK",
  "ENABLE_MAINNET",
  "MAX_ROUND_SIZE_LAMPORTS",
  "MIN_DEPOSIT_LAMPORTS",
  "MAX_DEPOSIT_LAMPORTS",
  "REVEAL_OFFSET_SLOTS",
  "POOL_TARGET_SOL",
  "ROULETTE_PROGRAM_ID",
  "OPERATOR_KEYPAIR",
] as const;

function cfgWithFeeBps(feeBps: string): AppConfig {
  const saved: Partial<Record<string, string | undefined>> = {};
  for (const key of SOLANA_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.PLATFORM_FEE_BPS = feeBps;
  try {
    return resolveConfig(process.env);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key as string];
      else process.env[key as string] = value;
    }
  }
}

function onChainConfig(feeBps: number) {
  return { feeBps } as unknown as GlobalConfigData;
}

function backendStub(mode: ChainBackend["mode"], config: GlobalConfigData | null): ChainBackend {
  return {
    mode,
    realFunds: mode === "chain",
    getRound: async () => null,
    getParticipants: async () => [],
    getGlobalConfig: async () => config,
    getCurrentSlot: async () => 0n,
    getRevealBlockhash: async () => null,
    getHeadByTier: async () => [],
    runLifecycle: async () => null,
    deposit: async () => ({ signature: "", roundId: 0n }),
    treasuryAccrued: () => 0n,
  };
}

describe("effective fee", () => {
  it("reports the ON-CHAIN config in chain mode, not the environment value", async () => {
    const cfg = cfgWithFeeBps("200");
    const backend = backendStub("chain", onChainConfig(750));
    const fee = await createFeeResolver(backend, cfg)();

    // The environment says 200 bps, but rounds lock whatever the on-chain
    // config holds (750 stands in here) — the chain always wins.
    expect(fee.feeBps).toBe(750);
    expect(fee.winnerShareBps).toBe(9_250);
    expect(fee.source).toContain("on-chain");
  });

  it("reports the environment value in local mode, where it is what is enforced", async () => {
    const cfg = cfgWithFeeBps("200");
    const fee = await createFeeResolver(backendStub("local", null), cfg)();

    expect(fee.feeBps).toBe(200);
    expect(fee.winnerShareBps).toBe(9_800);
    expect(fee.source).toContain("PLATFORM_FEE_BPS");
  });

  it("falls back to the environment when the chain config cannot be read", async () => {
    const cfg = cfgWithFeeBps("200");
    const backend = backendStub("chain", null);
    const fee = await createFeeResolver(backend, cfg)();

    expect(fee.feeBps).toBe(200);
    expect(fee.source).toContain("fallback");
  });

  it("never fails a request when the lookup throws, and ignores absurd values", async () => {
    const cfg = cfgWithFeeBps("200");
    const throwing = {
      ...backendStub("chain", null),
      getGlobalConfig: async () => {
        throw new Error("rpc down");
      },
    } as ChainBackend;
    expect((await createFeeResolver(throwing, cfg)()).feeBps).toBe(200);

    const outOfRange = { feeBps: 99_999 } as unknown as GlobalConfigData;
    expect((await createFeeResolver(backendStub("chain", outOfRange), cfg)()).feeBps).toBe(200);
  });

  it("caches within the TTL so a polled endpoint does not hammer the RPC", async () => {
    const cfg = cfgWithFeeBps("200");
    const getGlobalConfig = vi.fn(async () => onChainConfig(750));
    const backend = { ...backendStub("chain", null), getGlobalConfig } as ChainBackend;
    const resolve = createFeeResolver(backend, cfg, FEE_CACHE_TTL_MS);

    await resolve();
    await resolve();
    expect(getGlobalConfig).toHaveBeenCalledTimes(1);

    await createFeeResolver(backend, cfg, 0)();
    expect(getGlobalConfig).toHaveBeenCalledTimes(2);
  });
});
