/** apps/api entrypoint — Fastify REST + SSE. */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { resolveConfig, MainnetDisabledError } from "@solana-roulette/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { registerRoutes } from "./routes.js";
import { startSettlementDriver, type SettlementDriverDeps } from "./settlement.js";
import { resolveBackend, type ChainBackend } from "./backend.js";
import { registerPreviewProxy } from "./previewProxy.js";
import { describeCustody, resolveCustody, type Custody } from "./custody.js";
import { registerAdminRoutes } from "./adminRoutes.js";
import { hydrateAdminState, initAdminState, depositState } from "./adminState.js";
import { reconcilePendingDeposits, type DepositDeps } from "./deposits.js";
import { ensureRoundPaid, type PayoutOutcome, type PayoutTarget } from "./payout.js";
import { txLog, safeEndpoint } from "./logger.js";

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

  await registerRoutes(app, { backend: active, connection, programId, cfg, custody });
  // Admin console API. Fails closed without ADMIN_TOKEN — there is no
  // read-only fallback, and it can only ever return public addresses.
  await registerAdminRoutes(app, {
    backend: active,
    connection,
    cfg,
    custody,
    backendReason,
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

  // Real devnet money movement. In "chain" mode the program pays winners; in
  // "local" mode the server pays them from the escrow with a real transfer.
  const depositDeps: DepositDeps = { backend: active, connection, custody, cfg, programId };
  const payoutService = active.mode === "chain"
    ? undefined
    : {
        ensureRoundPaid: (target: PayoutTarget): Promise<PayoutOutcome> =>
          ensureRoundPaid({ backend: active, connection, custody, cfg }, target),
      };

  // Operator settlement loop — automatic, no admin, no AI.
  const driverDeps: SettlementDriverDeps = { backend: active, cfg, payouts: payoutService };
  startSettlementDriver(driverDeps);

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

export async function start() {
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
