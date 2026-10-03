/**
 * Off-chain game settings (operator console).
 *
 * These are the levers the operator can change WITHOUT touching the on-chain
 * program, plus the persistence for them. Two kinds:
 *
 *   - `userCapLamportsByTier` — a per-wallet stake cap for one round of each
 *     pool lane (the "max SOL per user per pool"). The program has no per-user
 *     limit and no update instruction, so this is enforced in the deposit
 *     intent path only: a SOFT cap. It stops honest clients; it cannot stop a
 *     hand-built `deposit` instruction, and it never governs on-chain money.
 *   - `minDepositLamports` / `maxDepositLamports` — optional OFF-CHAIN
 *     overrides of the deposit bounds. They can only TIGHTEN the on-chain
 *     limits (validated below), so a deposit the API accepts is always one the
 *     program accepts too.
 *
 * Everything here is written through to the audit mirror (`game_settings`) so a
 * restart or redeploy does not silently reset an operator's limits. Without
 * `DATABASE_URL` it is in-memory only.
 *
 * The fee is NOT here: it lives on chain (`set_fee`) and is changed by a signed
 * instruction, never by a database row.
 */
import { txLog } from "./logger.js";
import { postgresMirror } from "./store.js";

const DB_TIMEOUT_MS = 3_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`game settings read timed out after ${ms}ms`)), ms);
    timer.unref?.();
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    );
  });
}

export interface GameSettings {
  /** Per-wallet cap (lamports) for one round of each pool lane; "0" = no cap. */
  userCapLamportsByTier: [string, string, string];
  /** Off-chain deposit floor (lamports) or null to use the on-chain value. */
  minDepositLamports: string | null;
  /** Off-chain deposit ceiling (lamports) or null to use the on-chain value. */
  maxDepositLamports: string | null;
  updatedAt: string;
  updatedBy: string;
}

/** Live on-chain bounds the off-chain overrides must stay within. */
export interface SettingsBounds {
  onChainMinDepositLamports: bigint;
  onChainMaxDepositLamports: bigint;
  tierCapsLamports: bigint[];
}

function defaults(): GameSettings {
  return {
    userCapLamportsByTier: ["0", "0", "0"],
    minDepositLamports: null,
    maxDepositLamports: null,
    updatedAt: new Date().toISOString(),
    updatedBy: "boot",
  };
}

function clone(s: GameSettings): GameSettings {
  return { ...s, userCapLamportsByTier: [...s.userCapLamportsByTier] as [string, string, string] };
}

let settings: GameSettings = defaults();

/** Boot default (in-memory) — the mirror may override it in `hydrate`. */
export function initGameSettings(): void {
  settings = defaults();
}

export function getGameSettings(): GameSettings {
  return clone(settings);
}

/** Effective deposit floor = off-chain override if set, else the on-chain one. */
export function effectiveMinDeposit(cfg: { minDepositLamports: bigint }): bigint {
  return settings.minDepositLamports !== null ? BigInt(settings.minDepositLamports) : cfg.minDepositLamports;
}

/** Effective deposit ceiling = off-chain override if set, else the on-chain one. */
export function effectiveMaxDeposit(cfg: { maxDepositLamports: bigint }): bigint {
  return settings.maxDepositLamports !== null ? BigInt(settings.maxDepositLamports) : cfg.maxDepositLamports;
}

/** Per-wallet cap for a pool lane; 0n means "no cap". */
export function userCapForTier(tier: number): bigint {
  const raw = settings.userCapLamportsByTier[tier];
  return raw ? BigInt(raw) : 0n;
}

export class SettingsError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string
  ) {
    super(`${code}: ${detail}`);
    this.name = "SettingsError";
  }
}

function toLamportsString(value: unknown, field: string): string {
  const n = typeof value === "string" ? value.trim() : value;
  if (n === "" || n === null || n === undefined) throw new SettingsError("invalid_" + field, "value is required");
  let v: bigint;
  try {
    v = BigInt(n as string | number);
  } catch {
    throw new SettingsError("invalid_" + field, `${field} must be an integer number of lamports`);
  }
  if (v < 0n) throw new SettingsError("invalid_" + field, `${field} must be >= 0`);
  return v.toString();
}

export interface GameSettingsInput {
  userCapLamportsByTier?: unknown;
  minDepositLamports?: unknown;
  maxDepositLamports?: unknown;
}

/**
 * Validate a partial settings update against the live on-chain bounds and merge
 * it into the current settings. Throws `SettingsError` on anything invalid.
 *
 * Rules (so the API never accepts a deposit the program would reject):
 *   - user cap ≥ 0 and ≤ that lane's on-chain pool cap (0 disables it);
 *   - min ≥ the on-chain minimum, max ≤ the on-chain maximum;
 *   - the resulting effective min ≤ effective max.
 */
export function applyGameSettingsInput(
  input: GameSettingsInput,
  bounds: SettingsBounds,
  actor = "admin"
): GameSettings {
  const next = clone(settings);

  if (input.userCapLamportsByTier !== undefined) {
    const raw = input.userCapLamportsByTier;
    if (!Array.isArray(raw) || raw.length !== 3) {
      throw new SettingsError("invalid_user_caps", "userCapLamportsByTier must be an array of 3 lamport values");
    }
    const caps = raw.map((v, tier) => {
      const s = toLamportsString(v, `userCapLamportsByTier[${tier}]`);
      const cap = BigInt(s);
      const lane = bounds.tierCapsLamports[tier] ?? 0n;
      if (cap > lane) {
        throw new SettingsError(
          "user_cap_above_pool",
          `user cap for tier ${tier} (${cap}) exceeds the pool cap (${lane})`
        );
      }
      return s;
    });
    next.userCapLamportsByTier = caps as [string, string, string];
  }

  if (input.minDepositLamports !== undefined) {
    next.minDepositLamports =
      input.minDepositLamports === null || input.minDepositLamports === ""
        ? null
        : toLamportsString(input.minDepositLamports, "minDepositLamports");
  }
  if (input.maxDepositLamports !== undefined) {
    next.maxDepositLamports =
      input.maxDepositLamports === null || input.maxDepositLamports === ""
        ? null
        : toLamportsString(input.maxDepositLamports, "maxDepositLamports");
  }

  const effMin = next.minDepositLamports !== null ? BigInt(next.minDepositLamports) : bounds.onChainMinDepositLamports;
  const effMax = next.maxDepositLamports !== null ? BigInt(next.maxDepositLamports) : bounds.onChainMaxDepositLamports;
  if (effMin < bounds.onChainMinDepositLamports) {
    throw new SettingsError("min_below_onchain", `min (${effMin}) is below the on-chain minimum (${bounds.onChainMinDepositLamports})`);
  }
  if (effMax > bounds.onChainMaxDepositLamports) {
    throw new SettingsError("max_above_onchain", `max (${effMax}) is above the on-chain maximum (${bounds.onChainMaxDepositLamports})`);
  }
  if (effMin > effMax) {
    throw new SettingsError("min_above_max", `effective min (${effMin}) exceeds effective max (${effMax})`);
  }

  return commit(next, actor);
}

function commit(next: GameSettings, actor: string): GameSettings {
  next.updatedAt = new Date().toISOString();
  next.updatedBy = actor;
  settings = next;
  postgresMirror.upsertGameSettings(JSON.stringify(settings));
  txLog.info("admin.settings_updated", {
    actor,
    userCapLamportsByTier: settings.userCapLamportsByTier,
    minDepositLamports: settings.minDepositLamports,
    maxDepositLamports: settings.maxDepositLamports,
  });
  return getGameSettings();
}

/** Restore from the audit mirror at boot. Never throws; env/in-memory default wins on failure. */
export async function hydrateGameSettings(): Promise<GameSettings> {
  try {
    const raw = await withTimeout(postgresMirror.readGameSettings(), DB_TIMEOUT_MS);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<GameSettings>;
      const merged = clone(settings);
      if (Array.isArray(parsed.userCapLamportsByTier) && parsed.userCapLamportsByTier.length === 3) {
        merged.userCapLamportsByTier = parsed.userCapLamportsByTier.map((v) => String(v)) as [string, string, string];
      }
      if (parsed.minDepositLamports !== undefined) merged.minDepositLamports = parsed.minDepositLamports;
      if (parsed.maxDepositLamports !== undefined) merged.maxDepositLamports = parsed.maxDepositLamports;
      merged.updatedAt = parsed.updatedAt ?? merged.updatedAt;
      merged.updatedBy = "database";
      settings = merged;
      txLog.info("admin.settings_restored", { from: "database" });
    }
  } catch (err) {
    txLog.warn("admin.settings_restore_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return getGameSettings();
}

/** Test-only reset so one suite cannot leak limits into the next. */
export function resetGameSettingsForTests(): void {
  settings = defaults();
}
