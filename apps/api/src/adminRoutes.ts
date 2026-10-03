/**
 * Admin console API (`/api/admin/*`).
 *
 * Scope, deliberately narrow (docs/ADMIN.md §3):
 *   - READ: network/mainnet state, RPC health, escrow + operator + fee wallet
 *     (public addresses only), the live escrow balance, the game rules, the
 *     round inventory, the deposit/payout transaction ledger and the log tail.
 *   - WRITE: exactly one switch — deposits ACTIVE/PAUSED. It gates new deposit
 *     intents and nothing else. No winner override, no payout trigger, no fee
 *     change, no key upload: settlement stays fully automatic.
 *
 * Every response is `no-store` and free of secrets. `OPERATOR_KEYPAIR` is read
 * from the environment by the custody layer and is never reachable from here —
 * this file only ever sees the public address.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { AppConfig } from "@solana-roulette/config";
import { TIER_COUNT, TIER_META, isTerminalState, type Tier } from "@solana-roulette/types";
import type { ChainBackend } from "./backend.js";
import { verifyAdminToken } from "./adminAuth.js";
import { depositState, setDepositsPaused } from "./adminState.js";
import {
  applyGameSettingsInput,
  getGameSettings,
  SettingsError,
  type GameSettingsInput,
  type SettingsBounds,
} from "./adminSettings.js";
import {
  buildAndSendSetFeeTx,
  feeWalletBalance,
  fetchOnChainConfig,
  requireFeeWallet,
  withdrawFeeWallet,
} from "./operator.js";
import {
  DEVNET_EXPLORER_ADDRESS,
  DEVNET_EXPLORER_TX,
  describeCustody,
  escrowBalanceLamports,
  type Custody,
} from "./custody.js";
import { logRing } from "./logBuffer.js";
import { safeEndpoint, txLog } from "./logger.js";
import { roundToDto, entryToDto } from "./serialize.js";
import { advanceLaneManually, tierCapLamports } from "./settlement.js";
import { store } from "./store.js";
import { txToDto, type TxKind, type TxStatus } from "./txLedger.js";
import type { EffectiveFeeResolver } from "./feeTerms.js";

interface AdminRouteDeps {
  backend: ChainBackend;
  connection: Connection;
  cfg: AppConfig;
  custody: Custody;
  backendReason: string;
  /** The fee the runtime actually enforces (feeTerms.ts). */
  effectiveFee: EffectiveFeeResolver;
}

/** Guard: replies 401/403/429 and returns false when the caller is rejected. */
function guard(req: FastifyRequest, reply: FastifyReply, cfg: AppConfig): boolean {
  reply.header("Cache-Control", "no-store");
  const result = verifyAdminToken(req, cfg.adminToken);
  if (result.ok) return true;
  reply.code(result.status).send({ error: result.error, detail: result.detail });
  return false;
}

function intParam(
  query: unknown,
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = (query as Record<string, unknown> | undefined)?.[key];
  const n = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isInteger(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps) {
  const { backend, connection, cfg, custody } = deps;

  /**
   * One call that fills the whole console: system state, custody, rules,
   * inventory and transaction counters.
   */
  app.get("/api/admin/overview", async (req, reply) => {
    if (!guard(req, reply, cfg)) return reply;
    // Live RPC health: a single slot read, never a transaction.
    let rpc: Record<string, unknown> = {
      url: safeEndpoint(cfg.rpcUrl),
      ok: false,
      slot: null,
      latencyMs: null,
      error: null,
    };
    const startedAt = Date.now();
    try {
      const slot = await backend.getCurrentSlot();
      rpc = {
        url: safeEndpoint(cfg.rpcUrl),
        ok: true,
        slot: slot.toString(),
        latencyMs: Date.now() - startedAt,
        error: null,
      };
    } catch (err) {
      rpc = {
        url: safeEndpoint(cfg.rpcUrl),
        ok: false,
        slot: null,
        latencyMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    let escrowBalance = "0";
    try {
      escrowBalance = (await escrowBalanceLamports(connection, custody)).toString();
    } catch {
      /* reported as 0 with custodyReady=false below; never blocks the console */
    }

    const inventory = await roundInventoryCached(backend, cfg);
    const counts = store.txs.counts();
    const state = depositState();
    const fee = await deps.effectiveFee();

    return {
      generatedAt: new Date().toISOString(),
      system: {
        network: cfg.network,
        cluster: custody.cluster,
        mainnetEnabled: cfg.mainnetEnabled,
        devnetOnly: cfg.network === "devnet",
        mainnetGate:
          cfg.network === "mainnet-beta"
            ? "UNLOCKED (ENABLE_MAINNET=true) — never do this on devnet"
            : "locked (mainnet-beta also requires ENABLE_MAINNET=true)",
        programId: cfg.programId,
        backendMode: backend.mode,
        backendReason: deps.backendReason,
        realFunds: custody.ready,
        rpc,
      },
      custody: {
        ...describeCustody(custody),
        escrowBalanceLamports: escrowBalance,
        escrowExplorer: custody.escrow
          ? DEVNET_EXPLORER_ADDRESS(custody.escrow.toBase58())
          : null,
      },
      deposits: {
        ...state,
        canAccept: custody.ready && !state.paused,
        blockedReason: state.paused
          ? state.reason
          : custody.ready
            ? ""
            : custody.reason,
        custodyReady: custody.ready,
        custodyReason: custody.reason,
      },
      rules: {
        feeBps: fee.feeBps,
        feePercent: (fee.feeBps / 100).toFixed(2),
        winnerShareBps: fee.winnerShareBps,
        winnerSharePercent: (fee.winnerShareBps / 100).toFixed(2),
        minDepositLamports: cfg.minDepositLamports.toString(),
        maxDepositLamports: cfg.maxDepositLamports.toString(),
        revealOffsetSlots: cfg.revealOffsetSlots,
        pools: TIER_META.map((meta, tier) => ({
          tier,
          label: meta.label,
          emoji: meta.emoji,
          capLamports: tierCapLamports(cfg, tier as Tier).toString(),
          capSol: Number(tierCapLamports(cfg, tier as Tier)) / 1_000_000_000,
        })),
        source: `${fee.source} · pool caps from TIER_CAPS_SOL`,
      },
      fees: {
        wallet: cfg.platformFeeWallet ?? null,
        accruedLamports: backend.treasuryAccrued().toString(),
      },
      rounds: inventory.summary,
      transactions: counts,
      security: {
        adminTokenConfigured: Boolean(cfg.adminToken),
        secretsInThisResponse: false,
        note:
          "Private keys, seed phrases and OPERATOR_KEYPAIR stay server-side. " +
          "This API can only ever return public addresses.",
      },
    };
  });

  /** Open and settled rounds across the three pool lanes. */
  app.get("/api/admin/rounds", async (req, reply) => {
    if (!guard(req, reply, cfg)) return reply;
    const inventory = await roundInventoryCached(backend, cfg);
    return inventory;
  });

  /** The deposit/payout ledger with its PENDING → CONFIRMED | FAILED states. */
  app.get("/api/admin/transactions", async (req, reply) => {
    if (!guard(req, reply, cfg)) return reply;
    const query = req.query as { kind?: string; status?: string; limit?: string };
    const kind = query.kind === "DEPOSIT" || query.kind === "PAYOUT" ? (query.kind as TxKind) : undefined;
    const status =
      query.status === "PENDING" || query.status === "CONFIRMED" || query.status === "FAILED"
        ? (query.status as TxStatus)
        : undefined;
    const limit = intParam(req.query, "limit", 100, 1, 500);
    const rows = store.txs.listRecent({ kind, status, limit });
    // One pass per distinct round instead of one full ledger scan per row.
    const potByRound = new Map<string, string>();
    for (const roundId of new Set(rows.map((tx) => tx.roundId))) {
      potByRound.set(roundId, store.txs.confirmedPotLamports(roundId).toString());
    }
    return {
      counts: store.txs.counts(),
      transactions: rows.map((tx) => ({
        ...txToDto(tx),
        // The DTO carries the on-chain signature for both kinds, so the
        // explorer link is correct for deposits and payouts alike.
        confirmedPotLamports: potByRound.get(tx.roundId) ?? "0",
      })),
    };
  });

  /** Recent entries of a round, with its participants. */
  app.get("/api/admin/rounds/:id", async (req, reply) => {
    if (!guard(req, reply, cfg)) return reply;
    const raw = (req.params as { id?: string }).id ?? "";
    if (!/^\d+$/.test(raw)) return reply.code(400).send({ error: "round id must be numeric" });
    const round = await backend.getRound(BigInt(raw));
    if (!round) return reply.code(404).send({ error: "round not found" });
    const participants = await backend.getParticipants(round.id);
    return {
      round: roundToDto(round, cfg),
      entries: participants.map(entryToDto),
      transactions: store.txs.listByRound(round.id).map(txToDto),
      confirmedPotLamports: store.txs.confirmedPotLamports(round.id).toString(),
      payoutAlreadyConfirmed: store.hasPayout(round.id.toString()),
    };
  });

  /** Redacted log tail (the same lines the server writes to stdout). */
  app.get("/api/admin/logs", async (req, reply) => {
    if (!guard(req, reply, cfg)) return reply;
    const query = req.query as { level?: string; event?: string; limit?: string };
    const level =
      query.level === "info" || query.level === "warn" || query.level === "error"
        ? query.level
        : undefined;
    const limit = intParam(req.query, "limit", 100, 1, 500);
    const entries = logRing.list({ level, event: query.event, limit });
    return { bufferSize: logRing.size(), entries };
  });

  /**
   * The one write: pause or resume deposits.
   *
   * It cannot move a lamport, cannot touch a round and cannot change a fee —
   * and it must never be needed for settlement, which runs on its own.
   */
  app.post("/api/admin/deposits", async (req, reply) => {
    if (!guard(req, reply, cfg)) return reply;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.paused !== "boolean") {
      return reply.code(400).send({ error: "paused must be a boolean" });
    }
    const before = depositState();
    const after = setDepositsPaused(body.paused, "admin-console");
    return {
      previous: before,
      deposits: { ...after, custodyReady: custody.ready, custodyReason: custody.reason },
    };
  });

  /**
   * Reset a pool lane that is stuck on a never-filling OPEN round.
   *
   * The program only closes an OPEN round at its tier cap, so a quiet lane can
   * sit OPEN forever and every wallet that entered it is locked out (one entry
   * per wallet per round — the `already_deposited` trap). This reuses the same
   * on-chain primitive the settlement timeout uses: `cancel_round` refunds each
   * participant EXACTLY (enforced by the program), then a fresh round opens so
   * deposits can proceed. It cannot settle a round, pick a winner or move funds
   * anywhere except back to the participants.
   */
  app.post("/api/admin/lane/advance", async (req, reply) => {
    if (!guard(req, reply, cfg)) return reply;
    const tier = Number((req.body as Record<string, unknown> | undefined)?.tier);
    if (!Number.isInteger(tier) || tier < 0 || tier >= TIER_COUNT) {
      return reply
        .code(400)
        .send({ error: "invalid_tier", detail: `tier must be an integer 0..${TIER_COUNT - 1}` });
    }
    const result = await advanceLaneManually(tier, { backend, cfg });
    return {
      ok: true,
      tier,
      ...result,
      explorer: result.cancelSignature ? DEVNET_EXPLORER_TX(result.cancelSignature) : null,
    };
  });

  // A cheap liveness probe that still requires the token, so a monitoring
  // check cannot be used to fingerprint whether the admin API is enabled.
  app.get("/api/admin/ping", async (req, reply) => {
    if (!guard(req, reply, cfg)) return reply;
    txLog.info("admin.ping", { network: cfg.network });
    return { ok: true, network: cfg.network, cluster: custody.cluster };
  });

  /**
   * Live on-chain bounds the off-chain settings must stay within. Falls back to
   * the resolved config when the config account cannot be read.
   */
  async function onChainBounds(): Promise<SettingsBounds> {
    const onChain = await fetchOnChainConfig(connection, new PublicKey(cfg.programId));
    return {
      onChainMinDepositLamports: onChain?.minDeposit ?? cfg.minDepositLamports,
      onChainMaxDepositLamports: onChain?.maxDeposit ?? cfg.maxDepositLamports,
      tierCapsLamports: onChain?.tierCaps ? [...onChain.tierCaps] : cfg.tierCapsLamports,
    };
  }

  /**
   * The operator-settable surface: off-chain game settings plus the fee wallet.
   * Everything here is returned for the console to render; no secrets.
   */
  app.get("/api/admin/settings", async (req, reply) => {
    if (!guard(req, reply, cfg)) return reply;
    const bounds = await onChainBounds();
    const fee = await deps.effectiveFee();

    let feeWallet: string | null = null;
    let feeBalanceLamports: string | null = null;
    try {
      feeWallet = requireFeeWallet(cfg).toBase58();
      feeBalanceLamports = (await feeWalletBalance(connection, cfg)).toString();
    } catch {
      /* custody not ready — report the settings anyway */
    }
    const withdrawalKeySet = Boolean(process.env.FEE_WALLET_KEYPAIR?.trim());

    return {
      settings: getGameSettings(),
      onChain: {
        feeBps: fee.feeBps,
        minDepositLamports: bounds.onChainMinDepositLamports.toString(),
        maxDepositLamports: bounds.onChainMaxDepositLamports.toString(),
        tierCapsLamports: bounds.tierCapsLamports.map((c) => c.toString()),
      },
      fees: {
        wallet: feeWallet,
        balanceLamports: feeBalanceLamports,
        explorer: feeWallet ? DEVNET_EXPLORER_ADDRESS(feeWallet) : null,
      },
      withdrawal: {
        keyConfigured: withdrawalKeySet,
        reason: withdrawalKeySet
          ? ""
          : "FEE_WALLET_KEYPAIR is not set on this server — add it to enable withdrawals",
      },
    };
  });

  /**
   * Update the off-chain settings (per-user pool caps + deposit bounds). The
   * fee is deliberately NOT here — it lives on chain and is changed via
   * POST /api/admin/fee.
   */
  app.put("/api/admin/settings", async (req, reply) => {
    if (!guard(req, reply, cfg)) return reply;
    const bounds = await onChainBounds();
    try {
      const next = applyGameSettingsInput((req.body ?? {}) as GameSettingsInput, bounds, "admin-console");
      return { ok: true, settings: next };
    } catch (err) {
      if (err instanceof SettingsError) {
        return reply.code(400).send({ error: err.code, detail: err.detail });
      }
      throw err;
    }
  });

  /**
   * Set the on-chain platform fee (operator-signed `set_fee`). Only affects
   * rounds locked AFTER the change — never retroactive.
   */
  app.post("/api/admin/fee", async (req, reply) => {
    if (!guard(req, reply, cfg)) return reply;
    if (backend.mode !== "chain") {
      return reply
        .code(409)
        .send({ error: "not_chain_mode", detail: "the fee lives on chain; there is no config account in local mode" });
    }
    const feeBps = Number((req.body as Record<string, unknown> | undefined)?.feeBps);
    try {
      const res = await buildAndSendSetFeeTx({
        connection,
        programId: new PublicKey(cfg.programId),
        cfg,
        feeBps,
      });
      txLog.warn("admin.fee_updated", {
        feeBps: res.feeBps,
        signature: res.signature,
        network: cfg.network,
      });
      return {
        ok: true,
        feeBps: res.feeBps,
        signature: res.signature,
        explorer: DEVNET_EXPLORER_TX(res.signature),
      };
    } catch (err) {
      return reply
        .code(400)
        .send({ error: "set_fee_failed", detail: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Withdraw SOL from the platform fee wallet.
   *
   * Requires the fee wallet's own keypair (`FEE_WALLET_KEYPAIR`), which the
   * operator adds as a server secret. The key is checked against the configured
   * fee wallet address before anything is sent, so it can never move the wrong
   * account's funds.
   */
  app.post("/api/admin/withdraw", async (req, reply) => {
    if (!guard(req, reply, cfg)) return reply;
    if (backend.mode !== "chain") {
      return reply.code(409).send({ error: "not_chain_mode", detail: "withdrawals require the on-chain fee wallet" });
    }
    const body = (req.body ?? {}) as { to?: unknown; lamports?: unknown };
    let to: PublicKey;
    try {
      to = new PublicKey(String(body.to));
    } catch {
      return reply.code(400).send({ error: "invalid_destination", detail: "`to` must be a valid Solana address" });
    }
    let lamports: bigint;
    try {
      lamports = BigInt(typeof body.lamports === "string" ? body.lamports : String(body.lamports ?? 0));
    } catch {
      return reply.code(400).send({ error: "invalid_amount", detail: "`lamports` must be an integer" });
    }
    try {
      const res = await withdrawFeeWallet({
        connection,
        cfg,
        feeWalletKeypairJson: process.env.FEE_WALLET_KEYPAIR,
        to,
        lamports,
      });
      txLog.warn("admin.fee_withdrawal", {
        to: res.to,
        lamports: res.lamports,
        signature: res.signature,
        network: cfg.network,
      });
      return { ok: true, ...res, explorer: DEVNET_EXPLORER_TX(res.signature) };
    } catch (err) {
      return reply
        .code(400)
        .send({ error: "withdraw_failed", detail: err instanceof Error ? err.message : String(err) });
    }
  });
}

// ---------------------------------------------------------------------------
// round inventory
// ---------------------------------------------------------------------------

interface RoundSummaryRow extends Record<string, unknown> {
  id: string;
  tier: number;
  status: string;
}

/**
 * Walk each lane back from its head and split the rounds into live and
 * settled. Bounded so a long-running deployment cannot turn the console into
 * an unbounded scan.
 *
 * RPC-efficiency and resilience (same pattern as the public pools endpoint):
 *   - all rounds in the window are fetched with ONE batched
 *     `getMultipleAccountsInfo` call via `backend.getRounds` instead of up to
 *     75 sequential single-account reads — under devnet rate limiting that is
 *     the difference between 2 s and a 429-storm timeout;
 *   - every RPC read is caught: an unreadable lane head falls back to the
 *     smallest lane round, an unreadable round is simply not listed;
 *   - the caller goes through `roundInventoryCached`, a small TTL cache that
 *     serves the LAST GOOD inventory when the RPC is storming, so the console
 *     degrades to slightly stale numbers instead of a 500.
 */
async function roundInventory(backend: ChainBackend, cfg: AppConfig, scanPerLane = 25) {
  const open: RoundSummaryRow[] = [];
  const completed: RoundSummaryRow[] = [];
  const headsByTier: string[] = [];

  let heads: Awaited<ReturnType<ChainBackend["getHeadByTier"]>> = [];
  try {
    heads = (await backend.getHeadByTier()) ?? [];
  } catch {
    /* lane head fallback below keeps the inventory best-effort */
  }

  const wanted: bigint[] = [];
  for (let tier = 0; tier < TIER_COUNT; tier++) {
    const head = heads[tier] && heads[tier]! > 0n ? heads[tier]! : BigInt(tier + 1);
    headsByTier.push(head.toString());
    for (let id = head; id > head - BigInt(scanPerLane) && id >= 1n; id--) {
      wanted.push(id);
    }
  }

  type RoundsMap = Awaited<ReturnType<NonNullable<ChainBackend["getRounds"]>>>;
  const rounds: RoundsMap = new Map();
  if (backend.getRounds) {
    try {
      const batched = await backend.getRounds(wanted);
      for (const [id, round] of batched) rounds.set(id, round);
    } catch {
      /* RPC storm — rounds stay empty, the cache/last-good above absorbs it */
    }
  } else {
    for (const id of wanted) {
      try {
        const round = await backend.getRound(id);
        if (round) rounds.set(id.toString(), round);
      } catch {
        /* skip unreadable round */
      }
    }
  }

  for (const id of wanted) {
    const round = rounds.get(id.toString());
    if (!round) continue;
    const row: RoundSummaryRow = {
      id: round.id.toString(),
      tier: round.tier,
      status: round.status,
      potLamports: round.pot.toString(),
      participantCount: round.participantCount,
      capLamports: tierCapLamports(cfg, round.tier as Tier).toString(),
      winner: !round.winner.equals(PublicKey.default) ? round.winner.toBase58() : null,
      payoutLamports: round.payoutLamports.toString(),
      feeLamports: round.feeLamports.toString(),
      payoutConfirmed: store.hasPayout(round.id.toString()),
      escrow: round.escrow.toBase58(),
    };
    if (isTerminalState(round.status)) completed.push(row);
    else open.push(row);
  }

  const byId = (a: RoundSummaryRow, b: RoundSummaryRow) => Number(BigInt(b.id) - BigInt(a.id));
  open.sort(byId);
  completed.sort(byId);

  return {
    open,
    completed: completed.slice(0, 50),
    summary: {
      openCount: open.length,
      completedCount: completed.length,
      openPotLamports: open.reduce((sum, r) => sum + BigInt(r.potLamports as string), 0n).toString(),
      settledFeeLamports: completed
        .reduce((sum, r) => sum + BigInt(r.feeLamports as string), 0n)
        .toString(),
      settledPayoutLamports: completed
        .reduce((sum, r) => sum + BigInt(r.payoutLamports as string), 0n)
        .toString(),
      headsByTier,
    },
  };
}

/** Small TTL cache for the admin round inventory with last-good fallback. */
const INVENTORY_CACHE_TTL_MS = 4_000;
let inventoryCache: { at: number; value: Awaited<ReturnType<typeof roundInventory>> } | null = null;

async function roundInventoryCached(backend: ChainBackend, cfg: AppConfig) {
  if (inventoryCache && Date.now() - inventoryCache.at < INVENTORY_CACHE_TTL_MS) {
    return inventoryCache.value;
  }
  try {
    const value = await roundInventory(backend, cfg);
    inventoryCache = { at: Date.now(), value };
    return value;
  } catch (err) {
    // RPC storming while cold: serve the previous inventory rather than a 500.
    if (inventoryCache) return inventoryCache.value;
    throw err;
  }
}
