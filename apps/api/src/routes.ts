/** REST + SSE route handlers. Never trusts client-declared amounts or state. */
import type { FastifyInstance } from "fastify";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { AppConfig } from "@solana-roulette/config";
import {
  getRoundPda,
  getEscrowPda,
  verifyRoundData,
  deriveRandomness,
  decodeRound,
  type RoundData,
} from "@solana-roulette/verification";
import type { SseEvent, Tier } from "@solana-roulette/types";
import { TIER_COUNT, TIER_META, tierFromParam, depositMessage } from "@solana-roulette/types";
import { verifySubmittedTransaction } from "./verifyTx.js";
import { store, broadcast } from "./store.js";
import { buildCompletedHistory, historyDeps } from "./history.js";
import { roundToDto, entryToDto } from "./serialize.js";
import { tierCapLamports } from "./settlement.js";
import { isTerminalState } from "@solana-roulette/types";
import type { ChainBackend } from "./backend.js";
import { txToDto } from "./txLedger.js";
import {
  cancelDeposit,
  confirmDeposit,
  createDepositIntent,
  DepositError,
  type DepositDeps,
} from "./deposits.js";
import { describeCustody, escrowBalanceLamports, requestDevnetAirdrop, type Custody } from "./custody.js";
import { depositState } from "./adminState.js";
import { txLog } from "./logger.js";
import type { EffectiveFeeResolver } from "./feeTerms.js";

interface RouteDeps {
  backend: ChainBackend;
  connection: Connection;
  programId: PublicKey;
  cfg: AppConfig;
  custody: Custody;
  /** The fee the runtime actually enforces — never derived per request. */
  effectiveFee: EffectiveFeeResolver;
}

function roundIdFromParams(params: unknown): bigint | null {
  const id = (params as { id?: string }).id;
  if (!id || !/^\d+$/.test(id)) return null;
  return BigInt(id);
}

/** Bounded integer env knob with a safe fallback (matches history.ts). */
function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { backend, connection, programId, cfg, custody, effectiveFee } = deps;
  const depositDeps: DepositDeps = { backend, connection, custody, cfg, programId };

  // ---------- SSE ----------
  app.get("/api/events", (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    reply.raw.write("retry: 3000\n\n");
    const listener = (ev: SseEvent) => {
      reply.raw.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    };
    const removeListener = store.addListener(listener);
    req.socket.on("close", () => removeListener());
  });

  // ---------- config ----------
  // The fee reported here is the one the runtime enforces (feeTerms.ts), so the
  // UI can render it instead of repeating a number that could drift.
  app.get("/api/config", async () => {
    const fee = await effectiveFee();
    return {
      network: cfg.network,
      mainnetEnabled: cfg.mainnetEnabled,
      devnetOnly: cfg.network === "devnet",
      /** "chain" = deployed program. "local" = devnet ledger driving the rounds. */
      mode: backend.mode,
      /** Real devnet SOL moves whenever custody is ready — see /api/custody. */
      realFunds: custody.ready,
      /** Operator kill switch (public so the UI never invites a paused deposit). */
      depositsPaused: depositState().paused,
      custody: describeCustody(custody),
      programId: cfg.programId,
      platformFeeWallet: cfg.platformFeeWallet ?? null,
      feeBps: fee.feeBps,
      feeSource: fee.source,
      winnerShareBps: fee.winnerShareBps,
      maxRoundSizeLamports: cfg.maxRoundSizeLamports.toString(),
      minDepositLamports: cfg.minDepositLamports.toString(),
      maxDepositLamports: cfg.maxDepositLamports.toString(),
      revealOffsetSlots: cfg.revealOffsetSlots,
      tierCapsLamports: cfg.tierCapsLamports.map((c) => c.toString()),
      treasuryAccruedLamports: backend.treasuryAccrued().toString(),
    };
  });

  // ---------- the three independent pool lanes (live) ----------
  /**
   * `/api/pools` is polled by every open dashboard. Resolving each lane's last
   * completed round used to cost one RPC read per candidate id — up to ~150
   * single `getAccountInfo` calls per request. On the public devnet RPC that
   * burst is exactly what gets rate-limited (HTTP 429 "Connection rate limits
   * exceeded"), which used to turn the whole route into a 500 and flood the
   * log. Two changes fix it:
   *
   *   1. every lane's candidate ids are read in ONE batched
   *      `getMultipleAccountsInfo` call instead of ~150 single reads;
   *   2. the assembled payload is memoised briefly, so concurrent pollers share
   *      a single chain read.
   *
   * A transient RPC failure degrades to the last good payload and logs one
   * warning — it never 500s and never spams the log.
   *
   * The lane scan window (how far back a completed round is looked up) matches
   * the previous behaviour: 50 ids back from that lane's head.
   */
  const poolsTtlMs = intEnv("POOLS_CACHE_TTL_MS", 4_000, 0, 60_000);
  let poolsCache: { at: number; body: { pools: Array<Record<string, unknown>> } } | null = null;

  app.get("/api/pools", async () => {
    if (poolsCache && Date.now() - poolsCache.at < poolsTtlMs) return poolsCache.body;
    try {
      const body = await buildPools();
      if (poolsTtlMs > 0) poolsCache = { at: Date.now(), body };
      return body;
    } catch (err) {
      txLog.warn("pools.read_failed", {
        error: err instanceof Error ? err.message : String(err),
        detail: "serving the last good /api/pools payload",
      });
      if (poolsCache) return poolsCache.body;
      throw err;
    }
  });

  async function buildPools(): Promise<{ pools: Array<Record<string, unknown>> }> {
    const heads = await backend.getHeadByTier();
    const headOf = (tier: number) =>
      heads[tier] && heads[tier]! > 0n ? heads[tier]! : BigInt(tier + 1);

    // Union of the ids every lane needs, so all three lanes cost one read.
    const ids = new Set<string>();
    for (let tier = 0; tier < TIER_COUNT; tier++) {
      const head = headOf(tier);
      for (let id = head; id > head - 50n && id >= 1n; id--) ids.add(id.toString());
    }
    const rounds = await readRoundWindow([...ids].map((s) => BigInt(s)));

    const pools: Array<Record<string, unknown>> = [];
    for (let tier = 0; tier < TIER_COUNT; tier++) {
      const head = headOf(tier);
      const round = rounds.get(head.toString()) ?? null;
      const meta = TIER_META[tier as Tier];
      const cap = tierCapLamports(cfg, tier);
      const last = lastCompletedInWindow(rounds, tier, head);
      // A settling round's own result wins; otherwise show the previous round
      // so the last winner/payout stay visible once the next round opens.
      const settled = round && round.status === "COMPLETED" ? round : null;
      const shown = settled ?? last;
      const base = {
        tier,
        label: meta.label,
        capSol: meta.capSol,
        emoji: meta.emoji,
        accent: meta.accent,
        capLamports: cap.toString(),
        lastCompletedRoundId: last?.id.toString() ?? null,
        lastWinner: shown && !shown.winner.equals(PublicKey.default) ? shown.winner.toBase58() : null,
        lastPayoutLamports: shown ? shown.payoutLamports.toString() : null,
        lastFeeLamports: shown ? shown.feeLamports.toString() : null,
      };
      if (!round || round.legacy || isTerminalState(round.status)) {
        pools.push({
          ...base,
          roundId: null,
          status: "OPENING",
          potLamports: "0",
          totalWeight: "0",
          participantCount: 0,
          fillPercent: 0,
          winner: base.lastWinner,
          payoutLamports: base.lastPayoutLamports,
          feeLamports: base.lastFeeLamports,
          escrow: custody.escrow?.toBase58() ?? null,
        });
        continue;
      }
      const roundCap = tierCapLamports(cfg, round.tier);
      pools.push({
        ...base,
        tier: round.tier,
        capLamports: roundCap.toString(),
        roundId: round.id.toString(),
        status: round.status,
        potLamports: round.pot.toString(),
        totalWeight: round.totalWeight.toString(),
        participantCount: round.participantCount,
        fillPercent:
          roundCap > 0n ? Math.min(100, Number((round.pot * 10_000n) / roundCap) / 100) : 0,
        winner: base.lastWinner,
        payoutLamports: base.lastPayoutLamports,
        feeLamports: base.lastFeeLamports,
        escrow: round.escrow.toBase58(),
      });
    }
    return { pools };
  }

  /**
   * Read a set of round ids in as few RPC calls as possible. Chain mode batches
   * through `getMultipleAccountsInfo` (the same approach as history.ts, which
   * exists precisely to avoid getting rate-limited at boot); local mode is an
   * in-memory Map and goes through the backend. A single undecodable or missing
   * account is skipped, never fatal.
   */
  async function readRoundWindow(ids: bigint[]): Promise<Map<string, RoundData>> {
    const out = new Map<string, RoundData>();
    if (backend.mode === "chain" && ids.length > 0) {
      const CHUNK = 100; // Solana RPC caps a batch at 100 accounts
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const keys = chunk.map((id) => getRoundPda(programId, id)[0]);
        const infos = await connection.getMultipleAccountsInfo(keys);
        chunk.forEach((id, idx) => {
          const info = infos[idx];
          if (!info?.data) return;
          try {
            out.set(id.toString(), decodeRound(info.data));
          } catch {
            // A malformed/legacy account is simply not part of the window.
          }
        });
      }
      return out;
    }
    for (const id of ids) {
      const r = await backend.getRound(id);
      if (r) out.set(id.toString(), r);
    }
    return out;
  }

  /** Newest completed round of a lane, from an already-read window. */
  function lastCompletedInWindow(
    rounds: Map<string, RoundData>,
    tier: number,
    head: bigint
  ): RoundData | null {
    for (let id = head; id > head - 50n && id >= 1n; id--) {
      const r = rounds.get(id.toString());
      if (r && r.tier === tier && isTerminalState(r.status)) return r;
    }
    return null;
  }

  // ---------- rounds ----------
  app.get("/api/round/current", async (req) => {
    const tierParam = tierFromParam((req.query as { tier?: string }).tier);
    if (tierParam !== null) {
      const heads = await backend.getHeadByTier();
      const id = heads[tierParam] && heads[tierParam]! > 0n ? heads[tierParam]! : BigInt(tierParam + 1);
      return roundWithEntries(id);
    }
    const heads = await backend.getHeadByTier();
    const id = heads[0] && heads[0]! > 0n ? heads[0]! : 1n;
    const round = await backend.getRound(id);
    if (!round) return { round: null, entries: [] };
    return roundWithEntries(round.id);
  });

  async function roundWithEntries(id: bigint) {
    const round = await backend.getRound(id);
    // A legacy (pre-`reveal_input`) round cannot be deposited into: the
    // deployed program reverts with AccountDidNotDeserialize. Report it as
    // "no current round" so the lane reads as opening, never as depositable.
    if (!round || round.legacy) return { round: null, entries: [] };
    const participants = await backend.getParticipants(round.id);
    return {
      round: roundToDto(round, cfg),
      entries: participants.map(entryToDto),
    };
  }

  app.get("/api/round/:id", async (req, reply) => {
    const id = roundIdFromParams(req.params);
    if (id === null) return reply.code(400).send({ error: "round id must be numeric" });
    const round = await backend.getRound(id);
    if (!round) return reply.code(404).send({ error: "round not found" });
    const participants = await backend.getParticipants(round.id);
    return { round: roundToDto(round, cfg), entries: participants.map(entryToDto) };
  });

  app.get("/api/round/:id/entries", async (req, reply) => {
    const id = roundIdFromParams(req.params);
    if (id === null) return reply.code(400).send({ error: "round id must be numeric" });
    const round = await backend.getRound(id);
    if (!round) return reply.code(404).send({ error: "round not found" });
    const participants = await backend.getParticipants(round.id);
    return { entries: participants.map(entryToDto) };
  });

  app.get("/api/round/:id/verify", async (req, reply) => {
    const id = roundIdFromParams(req.params);
    if (id === null) return reply.code(400).send({ error: "round id must be numeric" });
    const round = await backend.getRound(id);
    if (!round) return reply.code(404).send({ error: "round not found" });
    const [roundPk] = getRoundPda(programId, round.id);
    const [escrowPk] = getEscrowPda(programId, round.id);
    const outcome = await verifyRoundData(round, {
      fetchRound: async () => round,
      fetchParticipants: () => backend.getParticipants(round.id),
      fetchRevealBlockhash: (revealSlot) => backend.getRevealBlockhash(revealSlot),
      deriveRandomness,
      roundKey: roundPk.toBase58(),
    });
    return {
      ok: outcome.ok,
      mode: backend.mode,
      trace: outcome.trace,
      round: roundToDto(round, cfg),
      escrow: escrowPk.toBase58(),
    };
  });

  /** Every transaction of a round with its PENDING/CONFIRMED/FAILED state. */
  app.get("/api/round/:id/transactions", async (req, reply) => {
    const id = roundIdFromParams(req.params);
    if (id === null) return reply.code(400).send({ error: "round id must be numeric" });
    return {
      roundId: id.toString(),
      confirmedPotLamports: store.txs.confirmedPotLamports(id).toString(),
      transactions: store.txs.listByRound(id).map(txToDto),
    };
  });

  /** Live escrow / signer balances straight from devnet — reconciliation aid. */
  app.get("/api/custody", async () => {
    const escrowBalance = await escrowBalanceLamports(connection, custody).catch(() => 0n);
    return {
      ...describeCustody(custody),
      escrowBalanceLamports: escrowBalance.toString(),
    };
  });

  /**
   * Completed rounds, rebuilt from the chain (and the audit mirror for the
   * payout signature) rather than from process memory, so a restart does not
   * empty history. See history.ts.
   */
  app.get("/api/history", async () => {
    const rounds = await buildCompletedHistory(historyDeps(backend, connection, programId));
    return { rounds };
  });

  // ---------- deposits (REAL devnet System transfers) ----------
  /**
   * Step 1 — open a PENDING deposit intent.
   *
   * The server decides the escrow address, the amount and the tier, and opens
   * exactly one PENDING record per (round, wallet). The client then builds a
   * REAL `SystemProgram.transfer`, signs it in the player's wallet, sends it to
   * the devnet RPC and reports the signature back to /deposit/confirm.
   */
  app.post("/api/round/:id/deposit/intent", async (req, reply) => {
    const id = roundIdFromParams(req.params);
    if (id === null) return reply.code(400).send({ error: "round id must be numeric" });
    const parsed = parseIntentBody(req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    try {
      const intent = await createDepositIntent(depositDeps, {
        roundId: id,
        wallet: parsed.value.wallet,
        amountLamports: parsed.value.amountLamports,
      });
      txLog.info("deposit.intent", {
        id: intent.depositId,
        roundId: intent.roundId,
        tier: intent.tier,
        wallet: parsed.value.wallet.toBase58(),
        amountLamports: intent.amountLamports,
        recipient: intent.escrow,
        network: intent.network,
        status: intent.status,
        resumed: intent.resumed,
      });
      return reply.code(200).send(intent);
    } catch (err) {
      return depositError(reply, err, "intent");
    }
  });

  /**
   * Step 2 — the client reports the signature it just got from devnet.
   *
   * The server re-reads the transaction from the chain. The round is credited
   * ONLY when the transfer is real, error-free, paid for by the player and
   * for the exact amount. A failed or rejected transaction is recorded as
   * FAILED and nothing is credited.
   */
  app.post("/api/round/:id/deposit/confirm", async (req, reply) => {
    const id = roundIdFromParams(req.params);
    if (id === null) return reply.code(400).send({ error: "round id must be numeric" });
    const parsed = parseConfirmBody(req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    if (parsed.value.depositRoundId !== null && parsed.value.depositRoundId !== id) {
      return reply.code(400).send({ error: "round_mismatch", detail: "deposit id belongs to another round" });
    }
    try {
      const result = await confirmDeposit(depositDeps, parsed.value);
      return reply.code(result.status).send(result.body);
    } catch (err) {
      return depositError(reply, err, "confirm");
    }
  });

  /** Step 3 — the player rejected in their wallet: FAILED, never credited. */
  app.post("/api/round/:id/deposit/cancel", async (req, reply) => {
    const id = roundIdFromParams(req.params);
    if (id === null) return reply.code(400).send({ error: "round id must be numeric" });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const depositId = typeof body.depositId === "string" ? body.depositId : "";
    if (!depositId) return reply.code(400).send({ error: "depositId is required" });
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 200) : "rejected by player";
    const result = cancelDeposit(depositId, reason);
    return reply.code(result.status).send(result.body);
  });

  /** Poll a deposit's on-chain state (PENDING → CONFIRMED | FAILED). */
  app.get("/api/deposit/:depositId", async (req, reply) => {
    const depositId = String((req.params as { depositId?: string }).depositId ?? "");
    const tx = store.txs.get(depositId);
    if (!tx) return reply.code(404).send({ error: "deposit_not_found" });
    return reply.code(200).send(txToDto(tx));
  });

  /** Devnet faucet: 1 devnet SOL for a connected wallet (rate limited). */
  app.post("/api/devnet/airdrop", async (req, reply) => {
    const parsed = parseAirdropBody(req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const result = await requestDevnetAirdrop(connection, parsed.value);
    const signature = result.signature ?? null;
    return reply.code(result.ok ? 200 : 429).send({
      ok: result.ok,
      wallet: parsed.value.toBase58(),
      lamports: "1000000000",
      signature,
      explorer: signature ? `https://explorer.solana.com/tx/${signature}?cluster=devnet` : null,
      error: result.error ?? null,
      faucetUrl: "https://faucet.solana.com",
    });
  });

  // ---------- tx verification (on-chain program path) ----------
  app.post("/api/transaction/verify", async (req, reply) => {
    const parsed = parseTxVerifyBody(req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const result = await verifySubmittedTransaction({
      connection,
      programId,
      signature: parsed.value.signature,
      kind: parsed.value.kind as "deposit" | "lock" | "settle" | "cancel" | "create",
      expectedRoundId: parsed.value.roundId ? BigInt(parsed.value.roundId) : undefined,
    });
    return reply.code(result.status).send(result.body);
  });
}

// ---------------------------------------------------------------------------
// body parsing
// ---------------------------------------------------------------------------

const BASE58_MIN = 32;
const BASE58_MAX = 88;
const BASE58_RE = new RegExp(`^[1-9A-HJ-NP-Za-km-z]{${BASE58_MIN},${BASE58_MAX}}$`);

/** A transaction signature is a 64-byte value in base58 (86-88 chars). */
function isSignature(value: string): boolean {
  return value.length >= 64 && value.length <= 90 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value);
}

/**
 * Canonical, round-bound deposit message — re-exported from the shared types
 * package so the browser and the server always agree byte for byte.
 */
export { depositMessage };

/** Deposit intent body: the player's wallet and the amount they want to send. */
function parseIntentBody(
  body: unknown
): { ok: true; value: { wallet: PublicKey; amountLamports: bigint } } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  const walletRaw = typeof b.wallet === "string" ? b.wallet : "";
  const amountRaw = typeof b.amountLamports === "string" ? b.amountLamports : "";
  if (!BASE58_RE.test(walletRaw)) return { ok: false, error: "wallet must be a base58 pubkey" };
  if (!/^\d+$/.test(amountRaw) || amountRaw === "0") {
    return { ok: false, error: "amountLamports must be a positive integer string" };
  }
  // Hardening: 19 digits is far beyond any sane deposit (≈10^10 SOL) while
  // keeping absurdly long digit strings out of BigInt/DB parsing.
  if (amountRaw.length > 19) {
    return { ok: false, error: "amountLamports is out of range" };
  }
  try {
    return { ok: true, value: { wallet: new PublicKey(walletRaw), amountLamports: BigInt(amountRaw) } };
  } catch {
    return { ok: false, error: "wallet is not a valid Solana address" };
  }
}

function parseConfirmBody(
  body: unknown
): { ok: true; value: { depositId: string; signature: string; depositRoundId: bigint | null } } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  const depositId = typeof b.depositId === "string" ? b.depositId : "";
  const signature = typeof b.signature === "string" ? b.signature : "";
  if (!depositId) return { ok: false, error: "depositId is required" };
  if (!isSignature(signature)) {
    return { ok: false, error: "signature must be a base58 transaction signature" };
  }
  const roundRaw = typeof b.roundId === "string" ? b.roundId : "";
  return {
    ok: true,
    value: { depositId, signature, depositRoundId: /^\d+$/.test(roundRaw) ? BigInt(roundRaw) : null },
  };
}

function parseAirdropBody(body: unknown): { ok: true; value: PublicKey } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body must be an object" };
  const raw = (body as Record<string, unknown>).wallet;
  if (typeof raw !== "string" || !BASE58_RE.test(raw)) return { ok: false, error: "wallet must be a base58 pubkey" };
  try {
    return { ok: true, value: new PublicKey(raw) };
  } catch {
    return { ok: false, error: "wallet is not a valid Solana address" };
  }
}

/** Uniform error mapping for the deposit lifecycle (never credits on error). */
function depositError(
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  err: unknown,
  stage: string
) {
  if (err instanceof DepositError) {
    return reply.code(err.httpStatus).send({ error: err.code, detail: err.message, stage, credited: false });
  }
  if (err instanceof Error && (err.name === "CustodyNotReadyError" || err.name === "MainnetCustodyDisabledError")) {
    return reply.code(503).send({ error: err.name, detail: err.message, stage, credited: false });
  }
  txLog.error("deposit.error", { stage, error: err instanceof Error ? err.message : String(err) });
  return reply.code(500).send({
    error: "deposit_failed",
    detail: err instanceof Error ? err.message : "unknown",
    stage,
    credited: false,
  });
}

function parseTxVerifyBody(
  body: unknown
): { ok: true; value: { signature: string; kind: string; roundId?: string } } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  const signature = typeof b.signature === "string" ? b.signature : undefined;
  const kind = typeof b.kind === "string" ? b.kind : undefined;
  if (!signature || !kind) return { ok: false, error: "signature and kind are required" };
  if (!isSignature(signature)) return { ok: false, error: "invalid signature format" };
  const allowedKinds = ["deposit", "lock", "settle", "cancel", "create"];
  if (!allowedKinds.includes(kind)) return { ok: false, error: `kind must be one of ${allowedKinds.join(", ")}` };
  const roundId = typeof b.roundId === "string" && /^\d+$/.test(b.roundId) ? b.roundId : undefined;
  return { ok: true, value: { signature, kind, roundId } };
}
