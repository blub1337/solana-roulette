/** apps/api entrypoint — Fastify REST + SSE. */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { resolveConfig, MainnetDisabledError } from "@solana-roulette/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { registerRoutes } from "./routes.js";
import { startSettlementDriver, rehydrateLaneHeads, type SettlementDriverDeps } from "./settlement.js";
import { resolveBackend, type ChainBackend } from "./backend.js";
import { registerPreviewProxy } from "./previewProxy.js";
import { describeCustody, resolveCustody, type Custody } from "./custody.js";
import { registerAdminRoutes } from "./adminRoutes.js";
import { historyDeps, rehydrateCompletedRounds } from "./history.js";
import { hydrateAdminState, initAdminState, depositState } from "./adminState.js";
import { hydrateGameSettings, initGameSettings } from "./adminSettings.js";
import { createFeeResolver } from "./feeTerms.js";
import { reconcilePendingDeposits, type DepositDeps } from "./deposits.js";
import { postgresMirror, store } from "./store.js";
import { ensureRoundPaid, type PayoutOutcome, type PayoutTarget } from "./payout.js";
import { txLog, safeEndpoint } from "./logger.js";
import { installProcessGuards } from "./processGuards.js";
import { registerChatRoutes } from "./chat.js";

export interface ApiDeps {
  connection: Connection;
  programId: PublicKey;
  /** Pre-resolved runtime; otherwise resolved from the environment. */
  backend?: ChainBackend;
}

export async function buildServer(deps?: ApiDeps) {
  const cfg = resolveConfig();
  // Boot default of the operator kill switch, then let the audit mirror win if
  // an operator paused deposits before the last restart (never the reverse).
  initAdminState(cfg.depositsPaused);
  await hydrateAdminState();
  initGameSettings();
  await hydrateGameSettings();
  await restoreTransactionLedger();
  const connection =
    deps?.connection ?? new Connection(cfg.rpcUrl, { commitment: "confirmed" });
  const programId = deps?.programId ?? new PublicKey(cfg.programId);

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  await app.register(cors, { origin: true });

  // One runtime for the whole process: the deployed program when it exists,
  // otherwise the devnet ledger. Reported in /api/health so the UI can never
  // present a simulation as real funds.
  let backend = deps?.backend;
  let backendReason = "provided by caller";
  if (!backend) {
    const resolution = await resolveBackend({ cfg, connection, programId });
    backend = resolution.backend;
    backendReason = resolution.reason;
  }
  const active = backend;

  // DEVNET custody: the escrow that receives deposits, the fee wallet and the
  // server-side payout signer. The signer comes from an env secret and is
  // never serialized into any response.
  let custody: Custody;
  try {
    custody = resolveCustody(cfg);
  } catch (err) {
    app.log.error(`[custody] ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  app.get("/api/health", async () => ({
    ok: true,
    network: cfg.network,
    mainnetEnabled: cfg.mainnetEnabled,
    /** "chain" = deployed Anchor program | "local" = devnet ledger for rounds */
    mode: active.mode,
    /** Real devnet SOL moves whenever custody is ready. */
    realFunds: custody.ready,
    custody: describeCustody(custody),
    /** Operator kill switch — false when new deposits are refused. */
    depositsPaused: depositState().paused,
    backendReason,
    programId: cfg.programId,
    platformFeeWallet: cfg.platformFeeWallet ?? null,
    rpcUrl: safeEndpoint(cfg.rpcUrl),
    commit: process.env.GIT_SHA ?? "dev",
  }));

  // One resolver for the whole process: the fee the runtime really charges
  // (on-chain config in chain mode, the environment in local mode). Every
  // response that mentions the fee reads it from here — see feeTerms.ts.
  const effectiveFee = createFeeResolver(active, cfg);

  // Real devnet money movement. In "chain" mode the program pays winners; in
  // "local" mode the server pays them from the escrow with a real transfer.
  // Built before the routes because the settlement driver needs it, and the
  // driver is handed to the routes.
  const depositDeps: DepositDeps = { backend: active, connection, custody, cfg, programId };
  const payoutService = active.mode === "chain"
    ? undefined
    : {
        ensureRoundPaid: (target: PayoutTarget): Promise<PayoutOutcome> =>
          ensureRoundPaid({ backend: active, connection, custody, cfg }, target),
      };

  // Settlement driver deps are built BEFORE the routes so the refund-or-wait
  // window a player reads from `/api/pools` is computed from the very same open
  // clock and deadline the driver refunds on.
  const driverDeps: SettlementDriverDeps = { backend: active, cfg, payouts: payoutService };
  await registerRoutes(app, {
    backend: active,
    connection,
    programId,
    cfg,
    custody,
    effectiveFee,
    driver: driverDeps,
  });
  // Live chat: wallet-signed sessions, SSE fan-out, per-wallet cooldown.
  await registerChatRoutes(app);
  // Admin console API. Fails closed without ADMIN_TOKEN — there is no
  // read-only fallback, and it can only ever return public addresses.
  await registerAdminRoutes(app, {
    backend: active,
    connection,
    cfg,
    custody,
    backendReason,
    effectiveFee,
  });

  // Dev/preview only: serve the UI through the same public port as the API.
  const previewUiUrl = process.env.PREVIEW_UI_URL;
  if (previewUiUrl) {
    registerPreviewProxy(app, previewUiUrl);
    app.log.info(`[preview] proxying UI traffic to ${previewUiUrl}`);
  }

  app.log.info(
    `[runtime] mode=${active.mode} custodyReady=${custody.ready} (${backendReason}) — ${custody.reason}`
  );

  // Operator settlement loop — automatic, no admin, no AI.
  // Repair the lane heads BEFORE the driver's first tick: the in-memory array
  // boots at [1,2,3] and, in chain mode, pointing lanes at long-completed
  // rounds makes the driver open duplicate rounds while the real heads never
  // advance (the "stale lane heads" bug). Never blocks listen(), never throws;
  // a failed pass leaves the boot defaults in place for the driver to heal
  // later (LANE_HEAD_REHYDRATE_MS). A few retries absorb an RPC hiccup at boot.
  void (async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const report = await rehydrateLaneHeads(driverDeps);
        if (report.restored > 0 || report.counter !== null) break;
      } catch {
        /* fall through to the next attempt */
      }
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  })();
  startSettlementDriver(driverDeps);

  // Rebuild history from the chain before the first request can ask for it.
  // Deliberately NOT awaited before listen(): a slow RPC must not delay boot,
  // and the route re-runs the same merge on read anyway. Never throws.
  void rehydrateCompletedRounds(historyDeps(active, connection, programId)).then((report) => {
    app.log.info(
      `[history] rehydrated ${report.recovered} completed round(s)` +
        (report.highest ? ` (newest #${report.highest})` : "")
    );
  });

  // Reconciler: deposits that never reached the chain must not stay PENDING,
  // and must never be credited after a refresh.
  const reaperMs = Number(process.env.DEPOSIT_RECONCILE_MS ?? 15_000);
  setInterval(() => {
    void reconcilePendingDeposits(depositDeps).catch((err: unknown) => {
      txLog.warn("deposit.reconcile_error", { error: err instanceof Error ? err.message : String(err) });
    });
  }, reaperMs).unref();

  return app;
}

/**
 * Put the idempotence guards back in place before the first request.
 *
 * The transaction state machine is held in memory and written through to the
 * audit mirror, so a restart would otherwise forget every CONFIRMED deposit,
 * every spent signature and every paid round — the exact conditions under
 * which the same transfer can be presented twice. Restoring is read-only,
 * bounded by `RESTORE_TIMEOUT_MS` and never fatal: without a database the
 * process simply relies on what it observes itself from that point on.
 */
const RESTORE_TIMEOUT_MS = 3_000;

async function restoreTransactionLedger(): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), RESTORE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([postgresMirror.readChainTxs(), deadline]);
    if (result === "timeout") {
      txLog.warn("ledger.restore_timeout", { timeoutMs: RESTORE_TIMEOUT_MS });
      return;
    }
    const restored = store.txs.restore(result);
    txLog.info("ledger.restored", { restored, mirrored: result.length });
  } catch (err) {
    txLog.warn("ledger.restore_failed", { error: err instanceof Error ? err.message : String(err) });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function start() {
  // A fire-and-forget RPC error (e.g. web3.js surfacing a 429 from the public
  // devnet RPC) must degrade the service, not kill it — see processGuards.ts.
  installProcessGuards();
  try {
    const app = await buildServer();
    const port = Number(process.env.PORT ?? 4000);
    await app.listen({ port, host: "0.0.0.0" });
    app.log.info(`API listening on 0.0.0.0:${port}`);
  } catch (err) {
    if (err instanceof MainnetDisabledError) {
      console.error("[fatal] MAINNET_DISABLED:", err.message);
      process.exit(1);
    }
    throw err;
  }
}

// Only auto-start when run directly (not when imported by tests). Works under
// tsx (argv[1] ends with server.ts) without import.meta (CJS-compatible).
const isMain = (process.argv[1] ?? "").includes("server");
if (isMain) {
  start();
}
