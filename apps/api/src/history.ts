/**
 * Durable completed-round history.
 *
 * `/api/history` used to be a projection of the in-memory `Store.rounds` Map,
 * so it went empty whenever the API (or the Render dyno) restarted — the exact
 * failure the product must not have: the chain keeps every settled round
 * forever, the API forgot them.
 *
 * THE RULE, and the reason this is not a second source of truth:
 *
 *   The chain is authoritative. Every financial/canonical field in a history
 *   row is read from the round's own on-chain `Round` account:
 *   status, pot, participant count, winner, winning ticket, randomness,
 *   reveal input/slots, payout and fee amounts, tier, fee_bps.
 *
 *   The audit mirror is NOT a source of truth. It contributes exactly the
 *   fields the chain cannot answer, and only as a fallback:
 *     - payoutTxSignature — the signature of the transaction that paid out
 *     - settlementVerified
 *     - completedAt
 *   When a signature is not recorded anywhere, it is RECOVERED FROM THE CHAIN
 *   (see `recoverPayoutSignature`) rather than invented.
 *
 * Two entry points, same merge:
 *   - `rehydrateCompletedRounds` — boot-time, repopulates the in-memory store
 *     so anything else reading `store.listCompletedRounds()` is consistent.
 *   - `buildCompletedHistory`    — read-time, backs `GET /api/history`.
 *
 * Neither throws: a failed rehydration degrades to whatever the chain gives
 * us and is logged, because history is a reporting surface and must never be
 * able to take the round loop down.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import {
  decodeRound,
  getEscrowPda,
  getRoundPda,
  type RoundData,
} from "@solana-roulette/verification";
import { isTerminalState } from "@solana-roulette/types";
import type { ChainBackend } from "./backend.js";
import { store, postgresMirror, type StoreRound } from "./store.js";
import { txLog } from "./logger.js";

/**
 * A completed round as returned by `GET /api/history`.
 *
 * The first block is the historical `/api/history` shape and is kept byte for
 * byte so existing consumers do not break; the second block is added data.
 * All lamport values are decimal strings — `u64`/`u128` do not fit a double.
 */
export interface HistoryRound {
  // --- preserved response contract ---
  id: string;
  tier: number;
  status: string;
  pot: string;
  feeBps: number;
  winner: string | null;
  payoutTxSignature: string | null;
  feeTxSignature: string | null;
  settlementVerified: boolean;
  completedAt: string | null;
  // --- added: the fields history could never show before ---
  participantCount: number;
  winningTicket: string | null;
  randomnessHex: string | null;
  /** The entropy input `settle_round` hashed, when the deployed program wrote it. */
  revealInputHex: string | null;
  lockSlot: string | null;
  revealSlot: string | null;
  payoutLamports: string | null;
  feeLamports: string | null;
  /** True when the financial fields above came from the round's chain account. */
  source: "chain" | "memory";
  /**
   * Where `payoutTxSignature` came from — `chain` means we found the payout by
   * watching the escrow balance, i.e. it is re-verified from chain data rather
   * than trusted from local state.
   */
  payoutTxSource: "chain" | "store" | "database" | null;
}

export interface HistoryDeps {
  backend: ChainBackend;
  /** Required to recover payout signatures; null in local mode. */
  connection: Connection | null;
  programId: PublicKey;
  /** How many round ids back from the counter to scan. */
  scanLimit: number;
  /** How many transactions to inspect per round when recovering a payout. */
  payoutScanLimit: number;
}

const DEFAULT_SCAN_LIMIT = 200;
const DEFAULT_PAYOUT_SCAN_LIMIT = 12;
const BATCH = 20;

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

export function historyDeps(
  backend: ChainBackend,
  connection: Connection | null,
  programId: PublicKey
): HistoryDeps {
  return {
    backend,
    // Payout recovery is an on-chain escrow-balance fact. In "local" mode there
    // is no escrow account, so it is never attempted.
    connection: backend.mode === "chain" ? connection : null,
    programId,
    scanLimit: intEnv("HISTORY_SCAN_LIMIT", DEFAULT_SCAN_LIMIT, 1, 5_000),
    payoutScanLimit: intEnv("HISTORY_PAYOUT_SCAN_LIMIT", DEFAULT_PAYOUT_SCAN_LIMIT, 1, 200),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (b: Uint8Array) => (b.length ? Buffer.from(b).toString("hex") : null);

/** Non-zero check: the program zero-fills `randomness`/`reveal_input` before settle. */
const isSet = (b: Uint8Array) => b.length === 32 && b.some((x) => x !== 0);

// ---------------------------------------------------------------------------
// read-time cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  at: number;
  key: string;
  rounds: HistoryRound[];
}
let cache: CacheEntry | null = null;

/** Test/CI seam: drop the memoised snapshot. */
export function resetHistoryCache(): void {
  cache = null;
}

// ---------------------------------------------------------------------------
// loading rounds
// ---------------------------------------------------------------------------

/**
 * Read a window of round accounts.
 *
 * In chain mode this batches through `getMultipleAccountsInfo`: a plain
 * `getRound` loop is one RPC round-trip per id, which on a 60+ round counter
 * is slow enough to get the public RPC rate-limiting us at boot. Local mode
 * has no RPC, so it goes through the backend.
 */
async function loadRounds(
  deps: HistoryDeps,
  ids: bigint[]
): Promise<Map<string, RoundData>> {
  const out = new Map<string, RoundData>();
  const { backend, connection, programId } = deps;

  if (backend.mode === "chain" && connection) {
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const keys = chunk.map((id) => getRoundPda(programId, id)[0]);
      const infos = await connection.getMultipleAccountsInfo(keys);
      chunk.forEach((id, idx) => {
        const info = infos[idx];
        if (!info?.data) return;
        try {
          out.set(id.toString(), decodeRound(info.data));
        } catch (err) {
          txLog.warn("history.decode_failed", {
            roundId: id.toString(),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
      if (i + BATCH < ids.length) await sleep(120);
    }
    return out;
  }

  for (const id of ids) {
    const round = await backend.getRound(id);
    if (round) out.set(id.toString(), round);
  }
  return out;
}

// ---------------------------------------------------------------------------
// payout signature recovery (authoritative, encoding-agnostic)
// ---------------------------------------------------------------------------

/**
 * Find the transaction that paid a settled round out, by watching the round's
 * escrow account.
 *
 * `pay_winners` moves exactly the pot out of the escrow, so the payout is the
 * one transaction whose escrow balance DROPS by precisely `round.pot`. That is
 * a stronger and simpler test than matching an instruction discriminator:
 * it works for any program encoding and it cannot be fooled by a deposit.
 *
 * Returns null (never throws) when the escrow history is unavailable.
 */
/**
 * Account list of a fetched transaction, legacy or v0.
 *
 * `getTransaction` hands back whichever version the transaction used, and
 * only a legacy `Message` exposes `accountKeys` directly. For a v0 message the
 * index space is static keys, then the writable loaded addresses, then the
 * readonly ones — getting that order wrong silently points index N at a
 * different account, so it is spelled out here rather than guessed.
 */
function accountKeysOf(
  tx: NonNullable<Awaited<ReturnType<Connection["getTransaction"]>>>
): PublicKey[] | null {
  const message = tx.transaction.message;
  if ("accountKeys" in message && Array.isArray(message.accountKeys)) {
    return message.accountKeys;
  }
  if (!("staticAccountKeys" in message)) return null;
  const loaded = tx.meta?.loadedAddresses;
  return [
    ...message.staticAccountKeys,
    ...(loaded?.writable ?? []),
    ...(loaded?.readonly ?? []),
  ];
}

async function recoverPayoutSignature(
  deps: HistoryDeps,
  round: RoundData
): Promise<string | null> {
  const { connection, programId, payoutScanLimit } = deps;
  if (!connection || round.status !== "COMPLETED" || round.pot === 0n) return null;
  const escrow = getEscrowPda(programId, round.id)[0];

  let signatures: Array<{ signature: string; err: unknown }>;
  try {
    // The escrow is touched by exactly create/deposit/pay, so it is the
    // narrowest possible candidate set for this round.
    signatures = await connection.getSignaturesForAddress(escrow, {
      limit: payoutScanLimit,
    });
  } catch {
    return null;
  }

  const target = -round.pot;
  for (const entry of signatures) {
    if (entry.err) continue;
    let tx: Awaited<ReturnType<Connection["getTransaction"]>>;
    try {
      tx = await connection.getTransaction(entry.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
    } catch {
      continue;
    }
    const meta = tx?.meta;
    if (!meta || !tx) continue;
    const keys = accountKeysOf(tx);
    if (!keys) continue;
    const idx = keys.findIndex((k) => k.equals(escrow));
    if (idx < 0) continue;
    // Balances come back as JS numbers; widen to bigint so the comparison is
    // exact rather than a float subtraction. Lamport balances here are far
    // below 2^53, so BigInt(number) is lossless.
    const pre = meta.preBalances[idx];
    const post = meta.postBalances[idx];
    if (pre === undefined || post === undefined) continue;
    if (BigInt(post) - BigInt(pre) === target) return entry.signature;
  }
  return null;
}

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

/** Non-chain fields the audit mirror can supply when memory is empty. */
export interface MirrorOverlay {
  payoutTxSignature: string | null;
  settlementVerified: boolean;
  completedAt: string | null;
}

function fromChain(round: RoundData): HistoryRound {
  const settled = round.status === "COMPLETED";
  return {
    id: round.id.toString(),
    tier: round.tier,
    status: round.status,
    pot: round.pot.toString(),
    feeBps: round.feeBps,
    winner:
      settled && !round.winner.equals(PublicKey.default) ? round.winner.toBase58() : null,
    payoutTxSignature: null,
    feeTxSignature: null,
    settlementVerified: false,
    completedAt: null,
    participantCount: round.participantCount,
    winningTicket: settled ? round.winningTicket.toString() : null,
    randomnessHex: settled ? hex(round.randomness) : null,
    revealInputHex: isSet(round.revealInput) ? hex(round.revealInput) : null,
    lockSlot: round.lockSlot ? round.lockSlot.toString() : null,
    revealSlot: round.revealSlot ? round.revealSlot.toString() : null,
    payoutLamports: settled ? round.payoutLamports.toString() : null,
    feeLamports: settled ? round.feeLamports.toString() : null,
    source: "chain",
    payoutTxSource: null,
  };
}

function fromMemory(r: StoreRound): HistoryRound {
  return {
    id: r.id,
    tier: r.tier,
    status: r.status,
    pot: r.pot,
    feeBps: r.feeBps,
    winner: r.winner,
    payoutTxSignature: r.payoutTxSignature,
    feeTxSignature: r.feeTxSignature,
    settlementVerified: r.settlementVerified,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    participantCount: r.participantCount ?? 0,
    winningTicket: r.winningTicket ?? null,
    randomnessHex: r.randomnessHex ?? null,
    revealInputHex: r.revealInputHex ?? null,
    lockSlot: r.lockSlot ?? null,
    revealSlot: r.revealSlot ?? null,
    payoutLamports: r.payoutLamports ?? null,
    feeLamports: r.feeLamports ?? null,
    source: "memory",
    payoutTxSource: r.payoutTxSignature ? "store" : null,
  };
}

/**
 * Assemble the completed-round list.
 *
 * Chain rows are the skeleton; memory and the audit mirror only fill the
 * fields the chain does not carry. Memory wins over the mirror because it is
 * strictly fresher within one process lifetime.
 */
async function collect(deps: HistoryDeps): Promise<HistoryRound[]> {
  const { backend, connection } = deps;

  // The shared on-chain counter bounds the scan: ids are strictly sequential
  // (`create_round` enforces `round_id == counter + 1`), so 1..counter is the
  // complete set of rounds that can exist.
  let counter = 0n;
  try {
    counter = (await backend.getGlobalConfig())?.roundCounter ?? 0n;
  } catch (err) {
    txLog.warn("history.counter_unavailable", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // No on-chain rounds yet: the in-memory view is all there is, and inventing
  // rows here would be the one thing worse than an empty list.
  if (counter === 0n) {
    return store
      .listCompletedRounds()
      .map(fromMemory)
      .sort(byNewestFirst);
  }

  const first = counter - BigInt(deps.scanLimit) + 1n > 1n ? counter - BigInt(deps.scanLimit) + 1n : 1n;
  const ids: bigint[] = [];
  for (let id = first; id <= counter; id++) ids.push(id);

  const rounds = await loadRounds(deps, ids);
  const overlay = await readOverlay();

  const out: HistoryRound[] = [];
  for (const round of rounds.values()) {
    if (!isTerminalState(round.status)) continue;
    const row = fromChain(round);
    const id = row.id;

    const mem = store.getRound(id);
    const db = overlay.get(id);
    if (mem) {
      if (mem.payoutTxSignature) {
        row.payoutTxSignature = mem.payoutTxSignature;
        row.payoutTxSource = "store";
      }
      if (mem.feeTxSignature) row.feeTxSignature = mem.feeTxSignature;
      if (mem.settlementVerified) row.settlementVerified = true;
      if (mem.completedAt) row.completedAt = mem.completedAt.toISOString();
    }
    if (!row.payoutTxSignature && db?.payoutTxSignature) {
      row.payoutTxSignature = db.payoutTxSignature;
      row.payoutTxSource = "database";
    }
    if (!row.completedAt && db?.completedAt) row.completedAt = db.completedAt;
    if (db?.settlementVerified) row.settlementVerified = true;

    // Nothing local knows this payout (first deploy after a restart, or a round
    // that settled while this process was down). Re-derive it from the chain.
    if (!row.payoutTxSignature && connection) {
      const sig = await recoverPayoutSignature(deps, round);
      if (sig) {
        row.payoutTxSignature = sig;
        row.payoutTxSource = "chain";
        // The escrow provably left with exactly the pot in that transaction,
        // which is the same end-to-end fact the in-process flag asserted.
        row.settlementVerified = true;
      }
    }

    out.push(row);
  }

  out.sort(byNewestFirst);
  return out;
}

function byNewestFirst(a: HistoryRound, b: HistoryRound): number {
  const x = BigInt(a.id);
  const y = BigInt(b.id);
  return x === y ? 0 : x > y ? -1 : 1;
}

// ---------------------------------------------------------------------------
// audit mirror read
// ---------------------------------------------------------------------------

let mirrorWarned = false;

async function readOverlay(): Promise<Map<string, MirrorOverlay>> {
  const out = new Map<string, MirrorOverlay>();
  try {
    const rows = await postgresMirror.readRoundHistory();
    for (const row of rows.values()) out.set(row.chainId, row);
  } catch {
    // A mirror is a convenience. Never let it break history.
    if (!mirrorWarned) {
      mirrorWarned = true;
      txLog.warn("history.mirror_unavailable", {
        error: "could not read the rounds audit mirror",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/** Read-time: the completed rounds behind `GET /api/history`. */
export async function buildCompletedHistory(deps: HistoryDeps): Promise<HistoryRound[]> {
  const ttl = intEnv("HISTORY_CACHE_TTL_MS", 15_000, 0, 600_000);
  const key = `${deps.backend.mode}:${deps.programId.toBase58()}`;
  if (ttl > 0 && cache && cache.key === key && Date.now() - cache.at < ttl) {
    return cache.rounds;
  }
  const rounds = await collect(deps);
  if (ttl > 0) cache = { at: Date.now(), key, rounds };
  return rounds;
}

/**
 * Boot-time rehydration: repopulate the in-memory store from the chain so a
 * restart does not present an empty round list, and so the admin console and
 * the settlement driver see the rounds this process did not create.
 *
 * Returns a short report for the boot log. Never throws.
 */
export async function rehydrateCompletedRounds(
  deps: HistoryDeps
): Promise<{ recovered: number; highest: string | null }> {
  try {
    const rounds = await buildCompletedHistory(deps);
    for (const row of rounds) {
      store.upsertRound({
        id: row.id,
        tier: row.tier,
        status: row.status,
        pot: row.pot,
        feeBps: row.feeBps,
        winner: row.winner,
        payoutTxSignature: row.payoutTxSignature,
        feeTxSignature: row.feeTxSignature,
        settlementVerified: row.settlementVerified,
        completedAt: row.completedAt ? new Date(row.completedAt) : null,
        participantCount: row.participantCount,
        winningTicket: row.winningTicket,
        randomnessHex: row.randomnessHex,
        revealInputHex: row.revealInputHex,
        lockSlot: row.lockSlot,
        revealSlot: row.revealSlot,
        payoutLamports: row.payoutLamports,
        feeLamports: row.feeLamports,
      });
    }
    return { recovered: rounds.length, highest: rounds[0]?.id ?? null };
  } catch (err) {
    txLog.warn("history.rehydrate_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { recovered: 0, highest: null };
  }
}
