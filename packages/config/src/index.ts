/**
 * Environment-driven configuration with a HARD mainnet gate.
 *
 * Financial rules live on-chain; this config only feeds the operator service
 * and public config endpoint. The frontend must never decide fees/payouts.
 * All lamport values are bigint; SOL env values are parsed via decimal string
 * math (no float drift).
 */

export type Network = "devnet" | "mainnet-beta";

/**
 * Platform fee wallet — the operator's public address (receives 7.5% ONLY).
 * Established product constant (public key, not a secret). Deposits NEVER go
 * here — they go into the round escrow PDA. docs/PAYMENTS.md §2.
 */
export const DEFAULT_FEE_WALLET = "6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR";

export class MainnetDisabledError extends Error {
  constructor() {
    super(
      "SOLANA_NETWORK=mainnet-beta requires ENABLE_MAINNET=true. " +
        "All transaction building refused. See docs/LEGAL_COMPLIANCE_CHECKLIST.md."
    );
    this.name = "MainnetDisabledError";
  }
}

export interface AppConfig {
  network: Network;
  mainnetEnabled: boolean;
  rpcUrl: string;
  programId: string;
  /** DEVNET ONLY — server-side operator keypair (JSON array or base58). */
  operatorKeypairJson?: string;
  /**
   * Admin console bearer token (server-side secret).
   *
   * NEVER serialized into a response, never sent to the browser as a value the
   * browser echoes back, and never written to the database. The browser only
   * holds it in sessionStorage and returns it in `x-admin-token`. When it is
   * unset the whole admin API refuses every request (fail closed) instead of
   * running open.
   */
  adminToken?: string;
  /** Boot default of the deposit kill switch (DEPOSITS_PAUSED=true). */
  depositsPaused: boolean;
  /** Platform fee wallet — public key ONLY, receives the 7.5% commission. */
  platformFeeWallet?: string;
  treasuryPubkey?: string;
  /**
   * DEVNET round escrow — the PUBLIC address that receives player deposits.
   * Defaults to the operator (payout signer) address so the same account
   * receives deposits and funds payouts. Public key only: never a secret.
   */
  depositEscrowWallet?: string;
  platformFeeBps: number;
  feeBps: number;
  /** Fee recipient fallback when PLATFORM_FEE_WALLET is unset. */
  poolTargetSol: number | null;
  maxRoundSizeLamports: bigint;
  minDepositLamports: bigint;
  maxDepositLamports: bigint;
  revealOffsetSlots: number;
  /** Max total pool volume per lane in lamports (index = tier; 1/10/100 SOL). */
  tierCapsLamports: [bigint, bigint, bigint];
  settlementPollMs: number;
  logLevel: string;
}

export const TIER_COUNT = 3;
const BPS_DENOMINATOR = 10_000;

/** Parse an integer lamport env value; accepts "10_000_000_000" underscores. */
function parseLamportsEnv(name: string, raw: string | undefined, fallback: bigint): bigint {
  if (raw === undefined || raw.trim() === "") return fallback;
  const cleaned = raw.trim().replace(/_/g, "");
  if (!/^\d+$/.test(cleaned)) {
    throw new Error(`${name} must be an integer (lamports), got "${raw}"`);
  }
  return BigInt(cleaned);
}

/** SOL string → lamports with EXACT decimal math (no floats). */
function solStringToLamports(name: string, raw: string): bigint {
  const s = raw.trim();
  if (!/^\d+(\.\d{1,9})?$/.test(s)) {
    throw new Error(`${name} must be a SOL amount like "10" or "2.25", got "${raw}"`);
  }
  const [whole, frac = ""] = s.split(".");
  const frac9 = (frac + "000000000").slice(0, 9);
  return BigInt(whole ?? "0") * 1_000_000_000n + BigInt(frac9);
}

/** Parse TIER_CAPS_SOL ("1,10,100") — exactly 3 ascending positive entries. */
function parseTierCaps(raw: string | undefined): [bigint, bigint, bigint] {
  const fallback: [bigint, bigint, bigint] = [1_000_000_000n, 10_000_000_000n, 100_000_000_000n];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length !== TIER_COUNT) {
    throw new Error(`TIER_CAPS_SOL must have exactly ${TIER_COUNT} comma-separated values`);
  }
  const caps = parts.map((p) => solStringToLamports("TIER_CAPS_SOL", p));
  for (let i = 0; i < caps.length; i++) {
    if (caps[i]! <= 0n) throw new Error("TIER_CAPS_SOL entries must be positive");
    if (i > 0 && caps[i]! <= caps[i - 1]!) {
      throw new Error("TIER_CAPS_SOL must be strictly ascending (1 < 10 < 100 SOL)");
    }
  }
  return [caps[0]!, caps[1]!, caps[2]!];
}

function parseOptionalNumber(name: string, raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return v;
}

/**
 * Resolve the full app config. Throws MainnetDisabledError when mainnet is
 * selected without the explicit ENABLE_MAINNET=true unlock.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const networkRaw = (env.SOLANA_NETWORK || "devnet").trim().toLowerCase();
  if (networkRaw !== "devnet" && networkRaw !== "mainnet-beta") {
    throw new Error(`SOLANA_NETWORK must be "devnet" or "mainnet-beta", got "${env.SOLANA_NETWORK}"`);
  }
  const network = networkRaw as Network;
  const mainnetEnabled = env.ENABLE_MAINNET === "true";
  if (network === "mainnet-beta" && !mainnetEnabled) {
    throw new MainnetDisabledError();
  }

  const platformFeeBps = parseLamportsEnv(
    "PLATFORM_FEE_BPS",
    env.PLATFORM_FEE_BPS,
    750n,
  );
  const feeBps = Number(platformFeeBps);
  if (feeBps < 0 || feeBps > BPS_DENOMINATOR) {
    throw new Error(`PLATFORM_FEE_BPS must be within 0..${BPS_DENOMINATOR}`);
  }

  const poolTargetSol = parseOptionalNumber("POOL_TARGET_SOL", env.POOL_TARGET_SOL);

  return {
    network,
    mainnetEnabled,
    rpcUrl: env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    programId: env.ROULETTE_PROGRAM_ID || "AAHBk1qbXCzsbiLe7TiXuZNTvNPVtovtC6NWk9tsi6EZ",
    operatorKeypairJson: env.OPERATOR_KEYPAIR || undefined,
    adminToken: env.ADMIN_TOKEN?.trim() || undefined,
    depositsPaused: env.DEPOSITS_PAUSED === "true",
    platformFeeWallet: env.PLATFORM_FEE_WALLET || env.TREASURY_PUBKEY || DEFAULT_FEE_WALLET,
    treasuryPubkey: env.TREASURY_PUBKEY || undefined,
    depositEscrowWallet: env.DEPOSIT_ESCROW_WALLET || undefined,
    platformFeeBps: feeBps,
    feeBps,
    poolTargetSol,
    maxRoundSizeLamports: parseLamportsEnv(
      "MAX_ROUND_SIZE_LAMPORTS",
      env.MAX_ROUND_SIZE_LAMPORTS,
      10_000_000_000n
    ),
    minDepositLamports: parseLamportsEnv("MIN_DEPOSIT_LAMPORTS", env.MIN_DEPOSIT_LAMPORTS, 10_000_000n),
    maxDepositLamports: parseLamportsEnv("MAX_DEPOSIT_LAMPORTS", env.MAX_DEPOSIT_LAMPORTS, 1_000_000_000n),
    revealOffsetSlots: Number(
      parseLamportsEnv("REVEAL_OFFSET_SLOTS", env.REVEAL_OFFSET_SLOTS, 32n)
    ),
    tierCapsLamports: parseTierCaps(env.TIER_CAPS_SOL),
    settlementPollMs: Number(parseLamportsEnv("SETTLEMENT_POLL_MS", env.SETTLEMENT_POLL_MS, 5_000n)),
    logLevel: env.LOG_LEVEL || "info",
  };
}

/**
 * Transaction-building gate: only an explicitly-unlocked mainnet config may
 * build instructions. Called before EVERY instruction-building path.
 */
export function assertNetworkAllowed(network: string): void {
  if (network === "mainnet-beta" && process.env.ENABLE_MAINNET !== "true") {
    throw new MainnetDisabledError();
  }
}

/** Alias operating on a resolved config (used by the API and tests). */
export function assertNetworkAllowsTransactions(cfg: AppConfig): void {
  if (cfg.network === "mainnet-beta" && !cfg.mainnetEnabled) {
    throw new MainnetDisabledError();
  }
}

/** Legacy alias used by the SDK client typings. */
export type RouletteEnvConfig = AppConfig;

/** Public-safe subset for GET /api/config — never includes secrets. */
export function publicConfig(cfg: AppConfig) {
  return {
    network: cfg.network,
    mainnetEnabled: cfg.mainnetEnabled,
    devnetOnly: cfg.network === "devnet",
    /** Kill switch state (public: the UI must not invite a paused deposit). */
    depositsPaused: cfg.depositsPaused,
    programId: cfg.programId,
    depositEscrowWallet: cfg.depositEscrowWallet ?? null,
    platformFeeWallet: cfg.platformFeeWallet ?? null,
    feeBps: cfg.feeBps,
    winnerShareBps: BPS_DENOMINATOR - cfg.feeBps,
    maxRoundSizeLamports: cfg.maxRoundSizeLamports.toString(),
    minDepositLamports: cfg.minDepositLamports.toString(),
    maxDepositLamports: cfg.maxDepositLamports.toString(),
    revealOffsetSlots: cfg.revealOffsetSlots,
    tierCapsLamports: cfg.tierCapsLamports.map((c) => c.toString()),
    randomnessProvider: "devnet-blockhash (devnet-only, NOT production-safe; VRF path in docs/RANDOMNESS.md)",
  };
}
