/**
 * The commission that is actually charged — and the only number the API reports.
 *
 * Where the number that decides a payout comes from:
 *
 *   chain mode — `lock_round` copies `GlobalConfig.fee_bps` into the round and
 *     `settle_round` computes the fee from that frozen snapshot, so the
 *     on-chain config is what players pay. `PLATFORM_FEE_BPS` is only a
 *     *proposal* until the config is seeded: reporting it while the chain says
 *     something else would understate the commission, so the chain wins.
 *
 *   local mode — the ledger enforces `cfg.feeBps` and its own GlobalConfig
 *     mirrors exactly that, so the same lookup returns the enforced number.
 *
 * Every consumer (`/api/config`, `/api/admin/overview`, and through them the
 * whole UI) goes through here, so a page can never show a percentage the
 * runtime does not charge.
 */
import type { AppConfig } from "@solana-roulette/config";
import type { ChainBackend } from "./backend.js";

const BPS_DENOMINATOR = 10_000;
/** The chain value is immutable for the life of a config, so a short cache is plenty. */
export const FEE_CACHE_TTL_MS = 30_000;

export interface EffectiveFee {
  feeBps: number;
  winnerShareBps: number;
  /** Human-readable origin, surfaced in the admin console. */
  source: string;
}

export type EffectiveFeeResolver = () => Promise<EffectiveFee>;

const LOCAL_SOURCE =
  "runtime ledger (PLATFORM_FEE_BPS) — frozen into every round when it locks; " +
  "not editable from the admin API by design";
const CHAIN_SOURCE =
  "on-chain GlobalConfig, frozen into every round when it locks (PLATFORM_FEE_BPS " +
  "only seeds a not-yet-initialized config); not editable from the admin API by design";
const FALLBACK_SOURCE =
  "environment fallback (PLATFORM_FEE_BPS) — the runtime config could not be read";

/**
 * Resolve the enforced fee once per process, cached for `ttlMs`.
 *
 * A failing lookup never throws: an unreadable config falls back to the
 * environment value and says so, because a fee display must not be able to
 * take the API down.
 */
export function createFeeResolver(
  backend: ChainBackend,
  cfg: AppConfig,
  ttlMs: number = FEE_CACHE_TTL_MS
): EffectiveFeeResolver {
  let cached: { at: number; value: EffectiveFee } | null = null;

  return async function effectiveFee(): Promise<EffectiveFee> {
    if (cached && Date.now() - cached.at < ttlMs) return cached.value;

    let feeBps = cfg.feeBps;
    let source = FALLBACK_SOURCE;

    if (backend.mode === "chain") {
      try {
        const onChain = await backend.getGlobalConfig();
        if (
          onChain &&
          Number.isInteger(onChain.feeBps) &&
          onChain.feeBps >= 0 &&
          onChain.feeBps <= BPS_DENOMINATOR
        ) {
          feeBps = onChain.feeBps;
          source = CHAIN_SOURCE;
        }
      } catch {
        /* keep the environment fallback */
      }
    } else {
      source = LOCAL_SOURCE;
    }

    cached = {
      at: Date.now(),
      value: { feeBps, winnerShareBps: BPS_DENOMINATOR - feeBps, source },
    };
    return cached.value;
  };
}
