/**
 * Chain backend selection.
 *
 * The platform runs against exactly one of two runtimes, chosen once at
 * startup and reported in `/api/health` so the UI can never misrepresent
 * where money (or a simulation of it) is moving:
 *
 *   "chain" — the deployed Anchor program. The ONLY runtime that can ever
 *             move real SOL. Requires the program account to exist on the
 *             configured RPC and an operator keypair to sign lifecycle txs.
 *
 *   "local" — the in-process devnet ledger (localLedger.ts). No lamports move,
 *             no pool wallet exists, no keys are held. Refuses to run on
 *             mainnet under any setting.
 *
 * `LEDGER_MODE` (auto | chain | local) overrides the probe. `auto` is the
 * default: the app is fully operable before the program is deployed and
 * switches to the real chain with no code change once it is.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import type { AppConfig } from "@solana-roulette/config";
import {
  fetchRoundAccount,
  fetchParticipantsForRound,
  getRoundPda,
  type GlobalConfigData,
  type ParticipantData,
  type RoundData,
} from "@solana-roulette/verification";
import { buildAndSendLifecycleTx, fetchOnChainConfig } from "./operator.js";
import { LocalLedger } from "./localLedger.js";

export type BackendMode = "chain" | "local";
export type LifecycleAction = "create" | "lock" | "settle" | "pay" | "cancel";

export interface LifecycleArgs {
  roundId?: bigint;
  tier?: number;
}

export interface LifecycleResult {
  signature: string;
  roundId: bigint;
  winner?: string;
  payoutLamports?: string;
  feeLamports?: string;
}

export interface DepositArgs {
  roundId: bigint;
  wallet: PublicKey;
  lamports: bigint;
}

export interface ChainBackend {
  readonly mode: BackendMode;
  /** True when this runtime can move real SOL. */
  readonly realFunds: boolean;
  getRound(roundId: bigint): Promise<RoundData | null>;
  getParticipants(roundId: bigint): Promise<ParticipantData[]>;
  getGlobalConfig(): Promise<GlobalConfigData | null>;
  getCurrentSlot(): Promise<bigint>;
  getRevealBlockhash(slot: bigint): Promise<Uint8Array | null>;
  /** Head round per pool lane. */
  getHeadByTier(): Promise<bigint[]>;
  runLifecycle(action: LifecycleAction, args?: LifecycleArgs): Promise<LifecycleResult | null>;
  /**
   * Credit a CONFIRMED deposit into the round. Called only after the transfer
   * has been re-read from the chain and found to be a real, error-free System
   * transfer of the right amount into the round escrow.
   *
   * In "chain" mode the program's own `deposit` instruction already credited
   * the round on chain, so the server only verifies and this is a no-op.
   */
  deposit(args: DepositArgs): Promise<LifecycleResult>;
  /** Treasury commission accrued so far in lamports (local mode). */
  treasuryAccrued(): bigint;
}

// ---------------------------------------------------------------------------
// chain backend (real Anchor program)
// ---------------------------------------------------------------------------

export function createChainBackend(
  connection: Connection,
  programId: PublicKey,
  cfg: AppConfig
): ChainBackend {
  return {
    mode: "chain",
    realFunds: true,
    async getRound(roundId) {
      return fetchRoundAccount(connection, programId, roundId);
    },
    async getParticipants(roundId) {
      const [roundPk] = getRoundPda(programId, roundId);
      return fetchParticipantsForRound(connection, programId, roundPk);
    },
    async getGlobalConfig() {
      return fetchOnChainConfig(connection, programId);
    },
    async getCurrentSlot() {
      return BigInt(await connection.getSlot());
    },
    async getRevealBlockhash(slot) {
      try {
        const block = await connection.getBlock(Number(slot), { maxSupportedTransactionVersion: 0 });
        return block ? new Uint8Array(new PublicKey(block.blockhash).toBytes()) : null;
      } catch {
        return null;
      }
    },
    async getHeadByTier() {
      // Lane heads are tracked by the settlement driver (store.currentRoundIdByTier)
      // and seeded from the shared on-chain counter on first read.
      const { store } = await import("./store.js");
      return store.currentRoundIdByTier;
    },
    async runLifecycle(action, args = {}) {
      const result = await buildAndSendLifecycleTx({
        connection,
        programId,
        cfg,
        action,
        roundId: args.roundId,
        tier: args.tier,
      });
      return result ? { ...result } : null;
    },
    async deposit(args) {
      // The program credited the round when it processed the deposit
      // instruction; the API's job here was to verify the transaction.
      return { signature: "", roundId: args.roundId };
    },
    treasuryAccrued() {
      return 0n;
    },
  };
}

// ---------------------------------------------------------------------------
// local backend (devnet ledger)
// ---------------------------------------------------------------------------

export function createLocalBackend(cfg: AppConfig, programId: PublicKey): ChainBackend & {
  ledger: LocalLedger;
} {
  const treasury = new PublicKey(
    cfg.platformFeeWallet ?? cfg.treasuryPubkey ?? PublicKey.default.toBase58()
  );
  const ledger = new LocalLedger({
    programId,
    operator: LocalLedger.deriveOperator(programId),
    treasury,
    feeBps: cfg.feeBps,
    tierCaps: cfg.tierCapsLamports,
    minDeposit: cfg.minDepositLamports,
    maxDeposit: cfg.maxDepositLamports,
    maxRoundSize: cfg.maxRoundSizeLamports,
    revealOffsetSlots: BigInt(cfg.revealOffsetSlots),
  });

  return {
    mode: "local",
    realFunds: false,
    ledger,
    async getRound(roundId) {
      return ledger.getRound(roundId);
    },
    async getParticipants(roundId) {
      return ledger.getParticipants(roundId);
    },
    async getGlobalConfig() {
      return ledger.globalConfig();
    },
    async getCurrentSlot() {
      return ledger.currentSlot();
    },
    async getRevealBlockhash(slot) {
      return ledger.revealBlockhash(slot);
    },
    async getHeadByTier() {
      return [...ledger.headByTier];
    },
    async runLifecycle(action, args = {}) {
      try {
        const result = ledger.runLifecycle(action, args);
        return { signature: result.signature, roundId: result.roundId };
      } catch (e) {
        // Mirrors the chain backend: a rejected instruction is a no-op, not a
        // crash. The driver treats null as "nothing happened this tick".
        console.warn(`[local-ledger] ${action} rejected:`, e instanceof Error ? e.message : e);
        return null;
      }
    },
    async deposit(args) {
      ledger.deposit(args);
      const after = ledger.getRound(args.roundId);
      return {
        signature: ledger.signatureFor("deposit", args.roundId, args.wallet, args.lamports),
        roundId: args.roundId,
        payoutLamports: after ? after.pot.toString() : undefined,
      };
    },
    treasuryAccrued() {
      return ledger.treasuryAccrued;
    },
  };
}

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

export interface BackendResolution {
  backend: ChainBackend;
  reason: string;
}

export class ProgramNotDeployedError extends Error {
  constructor(programId: string) {
    super(
      `Program ${programId} is not deployed on the configured RPC. ` +
        `Deploy it (anchor deploy + seed-config) or set LEDGER_MODE=local for the devnet ledger.`
    );
    this.name = "ProgramNotDeployedError";
  }
}

/**
 * Pick the runtime. Mainnet is chain-only: the local ledger is a devnet tool
 * and is refused there even when explicitly requested.
 */
export async function resolveBackend(args: {
  cfg: AppConfig;
  connection: Connection;
  programId: PublicKey;
}): Promise<BackendResolution> {
  const { cfg, connection, programId } = args;
  const mode = (process.env.LEDGER_MODE ?? "auto").trim().toLowerCase();

  if (cfg.network === "mainnet-beta") {
    if (mode === "local") {
      throw new Error("LEDGER_MODE=local is forbidden on mainnet-beta; the devnet ledger is devnet-only.");
    }
    const info = await connection.getAccountInfo(programId);
    if (!info) throw new ProgramNotDeployedError(programId.toBase58());
    return { backend: createChainBackend(connection, programId, cfg), reason: "mainnet: chain only" };
  }

  if (mode === "local") {
    return { backend: createLocalBackend(cfg, programId), reason: "LEDGER_MODE=local" };
  }
  if (mode === "chain") {
    const info = await connection.getAccountInfo(programId);
    if (!info) throw new ProgramNotDeployedError(programId.toBase58());
    return { backend: createChainBackend(connection, programId, cfg), reason: "LEDGER_MODE=chain" };
  }

  // auto: chain when the program is live AND an operator can sign for it.
  let deployed = false;
  try {
    deployed = !!(await connection.getAccountInfo(programId));
  } catch {
    deployed = false; // RPC unreachable — stay local rather than fail closed on liveness
  }
  if (deployed && cfg.operatorKeypairJson) {
    return { backend: createChainBackend(connection, programId, cfg), reason: "auto: program deployed + operator key present" };
  }
  return {
    backend: createLocalBackend(cfg, programId),
    reason: deployed
      ? "auto: program deployed but no OPERATOR_KEYPAIR — devnet ledger"
      : "auto: program not deployed — devnet ledger",
  };
}
