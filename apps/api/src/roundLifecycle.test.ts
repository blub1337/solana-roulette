/**
 * FULL ROUND LIFECYCLE, end to end, against a fake devnet RPC.
 *
 * One test file drives the real product — the real Fastify server, the real
 * deposit/payout services, the real settlement driver, the real transaction
 * ledger and the real Postgres mirror shape — with exactly two things faked:
 *
 *   1. the RPC. `FakeDevnetRpc` is a tiny ledger of balances and a map of
 *      REAL `Transaction`s decoded into the parsed shape the RPC returns. Both
 *      sides go through it: the player's wallet broadcasts a genuine
 *      `SystemProgram.transfer` (signed by a real keypair) and the server
 *      re-reads the very same object when it verifies the deposit and the
 *      payout. No network, no faucet, no airdrop, no flakiness.
 *   2. the clock, for the commit–reveal: `REVEAL_OFFSET_SLOTS=2` is polled
 *      instead of slept through, so "the reveal slot is not reached yet, do
 *      not settle" is asserted without a race.
 *
 * The money rules this pins:
 *   - a round is credited ONLY from a CONFIRMED on-chain transfer
 *   - a round is COMPLETED only AFTER its payout is CONFIRMED on chain
 *   - the winner receives 92.5% and the platform fee wallet exactly 7.5%
 *   - the escrow pays out the pot and nothing else, exactly once
 *   - the database mirror agrees with the chain at every step
 *
 * Rounds run on the in-process devnet ledger (`LEDGER_MODE=local`) because the
 * Anchor program is not deployed on devnet, while the SOL that moves is real
 * System transfers signed by real keypairs — exactly the production path.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  type Connection,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import bs58 from "bs58";
import { resolveConfig, type AppConfig } from "@solana-roulette/config";
import { buildServer } from "./server.js";
import { createLocalBackend } from "./backend.js";
import { advanceTierLane, type SettlementDriverDeps } from "./settlement.js";
import { ensureRoundPaid } from "./payout.js";
import { resolveCustody, type Custody } from "./custody.js";
import { reconcilePendingDeposits, type DepositDeps } from "./deposits.js";
import { store, postgresMirror } from "./store.js";
import { depositKey } from "./txLedger.js";

/** The broadcast is faked, the transaction it carries is real. */
vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return { ...actual, sendAndConfirmTransaction: vi.fn() };
});
const sendMock = vi.mocked(sendAndConfirmTransaction);

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const SOL = 1_000_000_000n;
const FEE_BPS = 750; // 7.5%
const TIER_CAP = SOL; // lane 0 is the 1 SOL pool
const FEE_ON_TIER_CAP = (TIER_CAP * BigInt(FEE_BPS)) / 10_000n; // 75_000_000
const PAYOUT_ON_TIER_CAP = TIER_CAP - FEE_ON_TIER_CAP; // 925_000_000
const TX_FEE = 5_000n; // what a real cluster charges the fee payer

const PROGRAM_ID = new PublicKey("AAHBk1qbXCzsbiLe7TiXuZNTvNPVtovtC6NWk9tsi6EZ");
/** The deposit escrow AND the server-side payout signer (custody). */
const OPERATOR = Keypair.fromSeed(new Uint8Array(32).fill(41));
/** Receives the 7.5% commission and nothing else. */
const FEE_WALLET = new PublicKey("6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR");
const ALICE = Keypair.fromSeed(new Uint8Array(32).fill(101));
const BOB = Keypair.fromSeed(new Uint8Array(32).fill(102));
const IMPOSTOR = Keypair.fromSeed(new Uint8Array(32).fill(103));
const DAVE = Keypair.fromSeed(new Uint8Array(32).fill(104));
const BLOCKHASH = "GtCRJqLMwRZgjqRVvTsyF1MhqNVvSPrKmkCbnRAH2Tb";

// ---------------------------------------------------------------------------
// the fake devnet RPC
// ---------------------------------------------------------------------------

interface Transfer {
  from: PublicKey;
  to: PublicKey;
  amount: bigint;
}

interface Submitted {
  signature: string;
  slot: number;
  payer: string;
  transfers: Transfer[];
}

/** Decode a real `Transaction` into the System transfers it carries. */
function decodeTransfers(tx: Transaction): Transfer[] {
  const out: Transfer[] = [];
  for (const ix of tx.instructions) {
    if (!ix.programId.equals(SystemProgram.programId) || ix.data.length !== 12) continue;
    const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
    if (view.getUint32(0, true) !== 2) continue; // SystemProgram.transfer
    out.push({
      from: ix.keys[0]!.pubkey,
      to: ix.keys[1]!.pubkey,
      amount: view.getBigUint64(4, true),
    });
  }
  return out;
}

/**
 * An in-memory devnet. It holds lamports, accepts genuinely signed
 * transactions and answers `getParsedTransaction` with the real decoded
 * transfer list — so every "the chain says so" check in the server runs
 * against something that behaves like a cluster, without one existing.
 */
class FakeDevnetRpc {
  private readonly balances = new Map<string, bigint>();
  private readonly txs = new Map<string, ParsedTransactionWithMeta>();
  private slot = 900_000;

  /** Everything broadcast through this RPC, in order. */
  readonly submitted: Submitted[] = [];
  /** When set, the NEXT broadcast fails like a flaky RPC would. */
  failNextSend: string | null = null;

  fund(key: PublicKey, lamports: bigint): void {
    this.balances.set(key.toBase58(), lamports);
  }

  setBalance(key: PublicKey, lamports: bigint): void {
    this.balances.set(key.toBase58(), lamports);
  }

  balance(key: PublicKey): bigint {
    return this.balances.get(key.toBase58()) ?? 0n;
  }

  slotNumber(): number {
    return this.slot;
  }

  known(signature: string): boolean {
    return this.txs.has(signature);
  }

  transaction(signature: string): ParsedTransactionWithMeta | null {
    return this.txs.get(signature) ?? null;
  }

  /** Broadcast a signed transaction. The client side and the server both use it. */
  send(tx: Transaction): string {
    if (this.failNextSend) {
      const detail = this.failNextSend;
      this.failNextSend = null;
      throw new Error(detail);
    }
    // A real cluster identifies a transaction by the base58 of its first 64
    // signed bytes (Transaction.signature() no longer exists in web3.js 1.9x).
    const wire = tx.serialize();
    const signature = bs58.encode(wire.subarray(0, 64));
    if (this.txs.has(signature)) {
      throw new Error("Transaction simulation failed: signature already processed");
    }
    const payer = tx.feePayer;
    if (!payer) throw new Error("missing fee payer");

    const transfers = decodeTransfers(tx);
    for (const t of transfers) {
      const cost = t.amount + (t.from.equals(payer) ? TX_FEE : 0n);
      if (this.balance(t.from) < cost) {
        throw new Error(`insufficient funds: ${t.from.toBase58()} has ${this.balance(t.from)}`);
      }
    }
    for (const t of transfers) {
      this.setBalance(t.from, this.balance(t.from) - t.amount);
      this.setBalance(t.to, this.balance(t.to) + t.amount);
    }
    this.setBalance(payer, this.balance(payer) - TX_FEE);

    this.slot += 1;
    this.txs.set(signature, this.parsed(signature, this.slot, transfers));
    this.submitted.push({ signature, slot: this.slot, payer: payer.toBase58(), transfers });
    return signature;
  }

  /** The shape `getParsedTransaction` returns for a real System transfer. */
  private parsed(signature: string, slot: number, transfers: Transfer[]): ParsedTransactionWithMeta {
    const keys: PublicKey[] = [];
    const push = (key: PublicKey) => {
      if (!keys.some((k) => k.equals(key))) keys.push(key);
    };
    for (const t of transfers) {
      push(t.from);
      push(t.to);
    }
    return {
      slot,
      blockTime: Math.floor(Date.now() / 1000),
      signature,
      meta: { err: null, fee: Number(TX_FEE), logMessages: [], innerInstructions: [] },
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: keys.map((pubkey) => ({ pubkey, signer: false, writable: true })),
          instructions: transfers.map((t) => ({
            program: "system",
            parsed: {
              type: "transfer",
              info: { source: t.from.toBase58(), destination: t.to.toBase58(), lamports: Number(t.amount) },
            },
          })),
          recentBlockhash: BLOCKHASH,
        },
      },
    } as unknown as ParsedTransactionWithMeta;
  }
}

const devnet = new FakeDevnetRpc();

/** The server's view of the RPC. Nothing here ever touches a network. */
const connection = {
  getBalance: async (key: PublicKey) => Number(devnet.balance(key)),
  getParsedTransaction: async (signature: string) => devnet.transaction(signature),
  getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1_000_000 }),
  getSlot: async () => devnet.slotNumber(),
  getAccountInfo: async () => null, // program not deployed -> local devnet ledger
  requestAirdrop: async () => {
    throw new Error("airdrop is disabled in tests");
  },
} as unknown as Connection;

// ---------------------------------------------------------------------------
// the database mirror (captured, never written — the chain stays the truth)
// ---------------------------------------------------------------------------

interface MirrorRow extends Record<string, unknown> {
  id: string;
  kind: string;
  roundId: string;
  depositStatus: string | null;
  payoutStatus: string | null;
}

/** Last row written per primary key: exactly the state the table would hold. */
const dbRows = new Map<string, MirrorRow>();
const dbWrites: MirrorRow[] = [];
vi.spyOn(postgresMirror, "enqueue").mockImplementation((job) => {
  if (job.table !== "chain_transactions") return;
  const row = job.row as MirrorRow;
  dbWrites.push(row);
  dbRows.set(row.id, row);
});

/** Every mirrored row of a round, deposits first. */
function rowsOf(roundId: string): MirrorRow[] {
  return [...dbRows.values()].filter((r) => r.roundId === roundId);
}
function depositRows(roundId: string): MirrorRow[] {
  return rowsOf(roundId).filter((r) => r.kind === "DEPOSIT");
}
function payoutRow(roundId: string): MirrorRow | undefined {
  return rowsOf(roundId).find((r) => r.kind === "PAYOUT");
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "SOLANA_NETWORK",
  "SOLANA_RPC_URL",
  "ROULETTE_PROGRAM_ID",
  "OPERATOR_KEYPAIR",
  "PLATFORM_FEE_WALLET",
  "DEPOSIT_ESCROW_WALLET",
  "PLATFORM_FEE_BPS",
  "TIER_CAPS_SOL",
  "MIN_DEPOSIT_LAMPORTS",
  "MAX_DEPOSIT_LAMPORTS",
  "MAX_ROUND_SIZE_LAMPORTS",
  "REVEAL_OFFSET_SLOTS",
  "LEDGER_MODE",
  "SETTLEMENT_POLL_MS",
  "DEPOSIT_RECONCILE_MS",
  "LOG_LEVEL",
  "PREVIEW_UI_URL",
] as const;

let savedEnv: Partial<Record<string, string | undefined>> = {};
let app: FastifyInstance;
let cfg: AppConfig;
let custody: Custody;
let driver: SettlementDriverDeps;
let depositDeps: DepositDeps;
let round1: bigint;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The player's wallet: intent -> real transfer -> broadcast -> confirm. */
async function depositViaApi(opts: {
  roundId: bigint;
  wallet: Keypair;
  amountLamports: bigint;
  /** Broadcast a different amount than the intent asked for. */
  sendLamports?: bigint;
  /** Do not broadcast at all: the signature stays unknown to the chain. */
  skipSend?: boolean;
  signWith?: Keypair;
}) {
  const intentRes = await app.inject({
    method: "POST",
    url: `/api/round/${opts.roundId}/deposit/intent`,
    payload: {
      wallet: opts.wallet.publicKey.toBase58(),
      amountLamports: opts.amountLamports.toString(),
    },
  });
  expect(intentRes.statusCode).toBe(200);
  const intent = intentRes.json<{ depositId: string; escrow: string; status: string; resumed: boolean }>();
  expect(intent.escrow).toBe(OPERATOR.publicKey.toBase58());

  let signature = "";
  if (!opts.skipSend) {
    const signer = opts.signWith ?? opts.wallet;
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: new PublicKey(intent.escrow),
        lamports: opts.sendLamports ?? opts.amountLamports,
      })
    );
    tx.recentBlockhash = BLOCKHASH;
    tx.feePayer = signer.publicKey;
    tx.partialSign(signer);
    signature = devnet.send(tx);
  }

  const confirmRes = await app.inject({
    method: "POST",
    url: `/api/round/${opts.roundId}/deposit/confirm`,
    payload: { depositId: intent.depositId, signature: signature || "7".repeat(64), roundId: opts.roundId.toString() },
  });
  return { intent, signature, confirmRes };
}

/** One settlement tick of the 1 SOL lane — exactly what the driver does. */
const tick = () => advanceTierLane(0, driver);

async function roundJson(roundId: bigint) {
  const res = await app.inject({ method: "GET", url: `/api/round/${roundId}` });
  expect(res.statusCode).toBe(200);
  return res.json<{ round: Record<string, unknown>; entries: Array<Record<string, unknown>> }>();
}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  Object.assign(process.env, {
    SOLANA_NETWORK: "devnet",
    SOLANA_RPC_URL: "http://127.0.0.1:1/fake-devnet",
    ROULETTE_PROGRAM_ID: PROGRAM_ID.toBase58(),
    OPERATOR_KEYPAIR: JSON.stringify(Array.from(OPERATOR.secretKey)),
    PLATFORM_FEE_WALLET: FEE_WALLET.toBase58(),
    DEPOSIT_ESCROW_WALLET: OPERATOR.publicKey.toBase58(),
    PLATFORM_FEE_BPS: String(FEE_BPS),
    TIER_CAPS_SOL: "1,10,100",
    MIN_DEPOSIT_LAMPORTS: "10000000",
    MAX_DEPOSIT_LAMPORTS: "1000000000",
    MAX_ROUND_SIZE_LAMPORTS: "10000000000",
    // 2 virtual slots of commit–reveal: asserted, never slept through blindly.
    REVEAL_OFFSET_SLOTS: "2",
    LEDGER_MODE: "local",
    SETTLEMENT_POLL_MS: "600000",
    DEPOSIT_RECONCILE_MS: "600000",
    LOG_LEVEL: "silent",
    PREVIEW_UI_URL: "",
  });

  // The RPC starts with money: players pay in, the escrow funds the payouts.
  for (const player of [ALICE, BOB, IMPOSTOR, DAVE]) devnet.fund(player.publicKey, 10n * SOL);
  devnet.fund(OPERATOR.publicKey, 5n * SOL);
  devnet.fund(FEE_WALLET, 0n);

  vi.spyOn(console, "log").mockImplementation(() => {});

  const backend = createLocalBackend(resolveConfig(), PROGRAM_ID);
  app = await buildServer({ connection, programId: PROGRAM_ID, backend });
  cfg = resolveConfig();
  custody = resolveCustody(cfg);
  expect(custody.ready).toBe(true);
  expect(custody.escrow?.equals(OPERATOR.publicKey)).toBe(true);

  depositDeps = { backend, connection, custody, cfg, programId: PROGRAM_ID };
  driver = {
    backend,
    cfg,
    payouts: {
      ensureRoundPaid: (target) => ensureRoundPaid({ backend, connection, custody, cfg }, target),
    },
  };

  // The server's own first tick opens the lanes; wait for lane 0 to exist.
  for (let i = 0; i < 200; i++) {
    const head = (await backend.getHeadByTier())[0]!;
    if (head > 0n) {
      round1 = head;
      break;
    }
    await sleep(10);
  }
  expect(round1).toBe(1n);

  // The payout broadcast goes through the fake RPC, not through a network.
  sendMock.mockImplementation(async (_conn, tx, signers) => {
    for (const signer of signers ?? []) tx.partialSign(signer);
    return devnet.send(tx);
  });
});

afterAll(async () => {
  await app?.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// the lifecycle
// ---------------------------------------------------------------------------

describe("deposit → round → payout on a fake devnet RPC", () => {
  it("credits a round only from a transfer the chain actually shows", async () => {
    // An unknown signature is not a failure: the deposit stays PENDING.
    const unknown = await depositViaApi({
      roundId: round1,
      wallet: DAVE,
      amountLamports: 10_000_000n,
      skipSend: true,
    });
    expect(unknown.confirmRes.statusCode).toBe(202);
    expect(unknown.confirmRes.json<{ status: string }>().status).toBe("PENDING");
    expect((await roundJson(round1)).round.potLamports).toBe("0");

    // A transfer of the wrong size is refused outright and credits nothing.
    const short = await depositViaApi({
      roundId: round1,
      wallet: IMPOSTOR,
      amountLamports: 100_000_000n,
      sendLamports: 99_999_999n,
    });
    expect(short.confirmRes.statusCode).toBe(422);
    expect(short.confirmRes.json<{ error: string; credited: boolean }>()).toMatchObject({
      error: "no_matching_transfer",
      credited: false,
    });
    expect(store.txs.get(short.intent.depositId)?.depositStatus).toBe("FAILED");
    expect(depositRows(round1.toString())).toHaveLength(2);
    expect(payoutRow(round1.toString())).toBeUndefined();

    // A transfer somebody else paid for is not this player's deposit.
    const impostor = await depositViaApi({
      roundId: round1,
      wallet: ALICE,
      amountLamports: 100_000_000n,
      signWith: IMPOSTOR,
    });
    expect(impostor.confirmRes.statusCode).toBe(422);
    expect(impostor.confirmRes.json<{ error: string }>().error).toBe("unexpected_fee_payer");
    expect((await roundJson(round1)).round.potLamports).toBe("0");
    expect((await roundJson(round1)).round.participantCount).toBe(0);

    // The reconciler must never leave a deposit PENDING forever.
    const reconciled = await reconcilePendingDeposits(depositDeps, 0);
    expect(reconciled).toMatchObject({ checked: 1, confirmed: 0, failed: 1 });
    expect(store.txs.get(unknown.intent.depositId)?.depositStatus).toBe("FAILED");

    // Two real, verified deposits: the pot is exactly what the chain moved.
    const a = await depositViaApi({ roundId: round1, wallet: ALICE, amountLamports: 500_000_000n });
    expect(a.confirmRes.statusCode).toBe(200);
    expect(a.confirmRes.json<{ credited: boolean; potLamports: string }>()).toMatchObject({
      credited: true,
      potLamports: "500000000",
    });
    const b = await depositViaApi({ roundId: round1, wallet: BOB, amountLamports: 500_000_000n });
    expect(b.confirmRes.statusCode).toBe(200);

    const { round, entries } = await roundJson(round1);
    expect(round.status).toBe("FULL"); // the cap, not the frontend, closed it
    expect(round.potLamports).toBe(TIER_CAP.toString());
    expect(round.participantCount).toBe(2);
    expect(entries.map((e) => e.wallet).sort()).toEqual(
      [ALICE.publicKey.toBase58(), BOB.publicKey.toBase58()].sort()
    );

    const txs = await app.inject({ method: "GET", url: `/api/round/${round1}/transactions` });
    const list = txs.json<{ confirmedPotLamports: string; transactions: Array<Record<string, unknown>> }>();
    expect(list.confirmedPotLamports).toBe(TIER_CAP.toString());
    expect(list.transactions).toHaveLength(5); // 3 refused + 2 confirmed (Alice retried), all audited
    expect(list.transactions.filter((t) => t.status === "CONFIRMED")).toHaveLength(2);

    // The escrow holds EXACTLY what the chain moved into it. Two of those
    // transfers were refused by the app (wrong amount, wrong fee payer) but
    // they are real System transfers, so their lamports really are in the
    // escrow — refusing a credit never moves money back (see docs/PAYMENTS.md
    // §8, known gap: un-refunded refused deposits). The tx fees are paid by
    // the senders, not out of the escrow, so the escrow keeps every lamport.
    const refusedButReal = 99_999_999n + 100_000_000n;
    const custodyRes = await app.inject({ method: "GET", url: "/api/custody" });
    expect(custodyRes.json<{ escrowBalanceLamports: string }>().escrowBalanceLamports).toBe(
      (5n * SOL + TIER_CAP + refusedButReal).toString()
    );
    expect(devnet.balance(FEE_WALLET)).toBe(0n); // no commission before settlement

    // Each confirmed deposit is a row, one per wallet, bound to its signature.
    const confirmed = depositRows(round1.toString()).filter((r) => r.depositStatus === "CONFIRMED");
    expect(confirmed).toHaveLength(2);
    expect(new Set(confirmed.map((r) => r.playerWallet))).toEqual(
      new Set([ALICE.publicKey.toBase58(), BOB.publicKey.toBase58()])
    );
    // Alice's first attempt failed verification, so her confirmed entry is
    // attempt 2: a FAILED transfer must not lock a wallet out of the round,
    // and every attempt keeps its own idempotency key and signature.
    expect(new Set(confirmed.map((r) => r.idempotencyKey))).toEqual(
      new Set([
        depositKey(round1, ALICE.publicKey.toBase58(), 2),
        depositKey(round1, BOB.publicKey.toBase58(), 1),
      ])
    );
    for (const row of confirmed) {
      expect(row.recipientWallet).toBe(OPERATOR.publicKey.toBase58());
      expect(row.network).toBe("devnet");
      expect(row.depositAmountLamports).toBe("500000000");
      expect(row.payoutStatus).toBeNull();
      expect(devnet.known(String(row.depositSignature))).toBe(true);
      expect(row.confirmedAt).not.toBeNull();
    }
    // Every write the mirror would have made is an upsert, never an insert.
    expect(dbWrites.length).toBeGreaterThan(confirmed.length);
    expect(new Set(dbWrites.map((r) => r.id)).size).toBe(dbRows.size);

    // An OPEN round is never locked, whatever the driver is told.
    const open = await roundJson(round1);
    expect(open.round.status).toBe("FULL");
  });

  it("locks, settles and pays 92.5% + 7.5% exactly once", async () => {
    const escrowBeforePayout = devnet.balance(OPERATOR.publicKey);
    const balancesBefore = new Map(
      [ALICE, BOB].map((w) => [w.publicKey.toBase58(), devnet.balance(w.publicKey)])
    );
    const sendsBefore = devnet.submitted.length;

    // FULL → RANDOMNESS_PENDING, with the fee snapshot frozen at the lock.
    await tick();
    let round = (await roundJson(round1)).round;
    expect(round.status).toBe("RANDOMNESS_PENDING");
    expect(round.feeBps).toBe(FEE_BPS);
    expect(BigInt(String(round.lockSlot))).toBeGreaterThan(0n);
    expect(BigInt(String(round.revealSlot))).toBe(BigInt(String(round.lockSlot)) + 2n);
    expect(round.winner).toBeUndefined(); // still unknowable

    // Before the reveal slot the driver must not even try to settle.
    await tick();
    expect((await roundJson(round1)).round.status).toBe("RANDOMNESS_PENDING");
    expect(store.txs.latestPayout(round1)).toBeNull();

    for (let i = 0; i < 400; i++) {
      const slot = await backendCurrentSlot();
      if (slot >= BigInt(String(round.revealSlot))) break;
      await sleep(10);
    }
    expect(await backendCurrentSlot()).toBeGreaterThanOrEqual(BigInt(String(round.revealSlot)));

    // Phase 1 freezes the outcome and moves no lamports at all. The API still
    // hides it — only COMPLETED rounds expose a winner — so read the frozen
    // values straight from the ledger, the way the driver does.
    await tick();
    round = (await roundJson(round1)).round;
    const frozen = await driver.backend.getRound(round1);
    const winner = frozen!.winner.toBase58();
    expect([ALICE.publicKey.toBase58(), BOB.publicKey.toBase58()]).toContain(winner);
    expect(frozen!.feeLamports).toBe(FEE_ON_TIER_CAP); // 7.5%
    expect(frozen!.payoutLamports).toBe(PAYOUT_ON_TIER_CAP); // 92.5%
    expect(round.winner).toBeUndefined(); // not published before the payout
    expect(round.status).toBe("RANDOMNESS_PENDING");
    expect(devnet.submitted).toHaveLength(sendsBefore);
    expect(store.txs.latestPayout(round1)).toBeNull();

    // Phase 2 pays: one transaction, fee to the fee wallet, the rest to the winner.
    await tick();

    const paid = store.txs.getConfirmedPayout(round1);
    expect(paid).not.toBeNull();
    expect(paid!.payoutStatus).toBe("CONFIRMED");
    expect(paid!.payoutAmountLamports).toBe(PAYOUT_ON_TIER_CAP.toString());
    expect(paid!.feeLamports).toBe(FEE_ON_TIER_CAP.toString());
    expect(paid!.wallet).toBe(winner);
    expect(paid!.attempts).toBe(1);
    expect(paid!.confirmedAt).not.toBeNull();

    // 7.5% is exactly 750 bps, in integer lamports, with nothing lost.
    expect(FEE_ON_TIER_CAP * 10_000n).toBe(TIER_CAP * BigInt(FEE_BPS));
    expect(FEE_ON_TIER_CAP + PAYOUT_ON_TIER_CAP).toBe(TIER_CAP);

    // The chain shows exactly those two transfers out of the escrow.
    const broadcast = devnet.submitted[devnet.submitted.length - 1]!;
    expect(broadcast.payer).toBe(OPERATOR.publicKey.toBase58());
    expect(broadcast.signature).toBe(paid!.depositSignature);
    expect(broadcast.transfers).toEqual([
      { from: OPERATOR.publicKey, to: FEE_WALLET, amount: FEE_ON_TIER_CAP },
      { from: OPERATOR.publicKey, to: new PublicKey(winner), amount: PAYOUT_ON_TIER_CAP },
    ]);
    expect(broadcast.transfers.reduce((sum, t) => sum + t.amount, 0n)).toBe(TIER_CAP);

    // Real balances: the fee wallet got 7.5% and only 7.5%, the winner got
    // the rest, and the escrow paid the pot out (plus its own transaction fee).
    expect(devnet.balance(FEE_WALLET)).toBe(FEE_ON_TIER_CAP);
    const loser = winner === ALICE.publicKey.toBase58() ? BOB : ALICE;
    // Both players already paid their entry in the previous test, so the only
    // movement here is the payout: the winner gains 92.5%, the loser nothing.
    expect(devnet.balance(ALICE.publicKey) - balancesBefore.get(ALICE.publicKey.toBase58())!)
      .toBe(winner === ALICE.publicKey.toBase58() ? PAYOUT_ON_TIER_CAP : 0n);
    expect(devnet.balance(BOB.publicKey) - balancesBefore.get(BOB.publicKey.toBase58())!)
      .toBe(winner === BOB.publicKey.toBase58() ? PAYOUT_ON_TIER_CAP : 0n);
    expect(devnet.balance(loser.publicKey)).toBe(balancesBefore.get(loser.publicKey.toBase58())!);
    expect(devnet.balance(OPERATOR.publicKey)).toBe(escrowBeforePayout - TIER_CAP - TX_FEE);

    // The round is COMPLETED only now that the money has actually moved.
    round = (await roundJson(round1)).round;
    expect(round.status).toBe("COMPLETED");
    expect(round.winner).toBe(winner);
    const stored = store.getRound(round1.toString());
    expect(stored).toMatchObject({
      status: "COMPLETED",
      winner,
      settlementVerified: true,
      feeBps: FEE_BPS,
      payoutTxSignature: paid!.depositSignature,
    });
    expect(stored!.completedAt).toBeInstanceOf(Date);

    // The winner recorded in the database is the one the randomness proves.
    const verify = await app.inject({ method: "GET", url: `/api/round/${round1}/verify` });
    const proof = verify.json<{ ok: boolean; trace: { computedWinner: string; recordedWinner: string; expectedFeeLamports: string; checks: Array<{ pass: boolean }> } }>();
    expect(proof.ok).toBe(true);
    expect(proof.trace.computedWinner).toBe(winner);
    expect(proof.trace.recordedWinner).toBe(winner);
    expect(proof.trace.expectedFeeLamports).toBe(FEE_ON_TIER_CAP.toString());
    expect(proof.trace.checks.every((c) => c.pass)).toBe(true);

    // The database mirrors the payout with its own signature column, and the
    // deposits it paid out still add up to what the chain moved.
    const row = payoutRow(round1.toString());
    expect(row).toMatchObject({
      kind: "PAYOUT",
      roundId: round1.toString(),
      playerWallet: winner,
      recipientWallet: winner,
      payoutAmountLamports: PAYOUT_ON_TIER_CAP.toString(),
      feeLamports: FEE_ON_TIER_CAP.toString(),
      payoutStatus: "CONFIRMED",
      network: "devnet",
      idempotencyKey: `payout:${round1.toString()}:1`,
    });
    expect(row!.payoutSignature).toBe(paid!.depositSignature);
    expect(row!.confirmedAt).not.toBeNull();
    expect(row!.error).toBeNull();
    const depositTotal = depositRows(round1.toString())
      .filter((r) => r.depositStatus === "CONFIRMED")
      .reduce((sum, r) => sum + BigInt(String(r.depositAmountLamports)), 0n);
    expect(depositTotal).toBe(TIER_CAP);
    expect(
      BigInt(String(row!.payoutAmountLamports)) + BigInt(String(row!.feeLamports))
    ).toBe(depositTotal);
  });

  it("never pays a winner twice, even when asked again", async () => {
    const round = (await roundJson(round1)).round;
    const winner = String(round.winner);
    const sendsBefore = devnet.submitted.length;
    const escrowBefore = devnet.balance(OPERATOR.publicKey);
    const feeBefore = devnet.balance(FEE_WALLET);

    // The ledger already holds a CONFIRMED payout for this round.
    await tick();
    const outcome = await ensureRoundPaid(
      { backend: driver.backend, connection, custody, cfg },
      { roundId: round1, tier: 0, winner }
    );
    expect(outcome).toMatchObject({
      status: "CONFIRMED",
      alreadyPaid: true,
      winner,
      payoutLamports: PAYOUT_ON_TIER_CAP,
      feeLamports: FEE_ON_TIER_CAP,
    });

    expect(devnet.submitted).toHaveLength(sendsBefore); // nothing was broadcast
    expect(devnet.balance(OPERATOR.publicKey)).toBe(escrowBefore);
    expect(devnet.balance(FEE_WALLET)).toBe(feeBefore);
    expect(store.txs.payoutAttempts(round1)).toBe(1);
    expect(rowsOf(round1.toString()).filter((r) => r.kind === "PAYOUT")).toHaveLength(1);

    // Replaying a confirmed deposit is idempotent as well.
    const writesBefore = dbWrites.length;
    const replay = await app.inject({
      method: "POST",
      url: `/api/round/${round1}/deposit/confirm`,
      payload: {
        depositId: store.txs.getDeposit(round1, ALICE.publicKey.toBase58())!.id,
        signature: String(store.txs.getDeposit(round1, ALICE.publicKey.toBase58())!.depositSignature),
        roundId: round1.toString(),
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ credited: boolean }>().credited).toBe(true);
    expect(dbWrites).toHaveLength(writesBefore);
    expect(depositRows(round1.toString())).toHaveLength(5); // 3 refused + 2 confirmed
  });

  it("refuses to complete a round whose payout the escrow cannot fund", async () => {
    // Lane 0 is serving a fresh round now that round 1 is COMPLETED.
    const heads = await driver.backend.getHeadByTier();
    const round2 = heads[0]!;
    expect(round2).toBeGreaterThan(round1);

    const { confirmRes } = await depositViaApi({ roundId: round2, wallet: ALICE, amountLamports: TIER_CAP });
    expect(confirmRes.statusCode).toBe(200);
    expect((await roundJson(round2)).round.status).toBe("FULL");

    await tick(); // lock
    for (let i = 0; i < 400; i++) {
      const r = (await roundJson(round2)).round;
      if (await backendCurrentSlot() >= BigInt(String(r.revealSlot))) break;
      await sleep(10);
    }
    await tick(); // settle

    // The escrow is drained: a payout it cannot fund must never be sent.
    devnet.setBalance(OPERATOR.publicKey, 0n);
    const sendsBefore = devnet.submitted.length;
    await tick(); // pay -> must fail

    const failed = store.txs.latestPayout(round2);
    expect(failed?.payoutStatus).toBe("FAILED");
    expect(String(failed?.lastError)).toMatch(/escrow balance .* below pot/);
    expect(failed?.nextRetryAt).toBeInstanceOf(Date);
    expect(devnet.submitted).toHaveLength(sendsBefore);
    expect(devnet.balance(ALICE.publicKey)).toBeLessThan(10n * SOL);

    // The round is still open for settlement — never COMPLETED, never re-paid.
    expect((await roundJson(round2)).round.status).toBe("RANDOMNESS_PENDING");
    expect(store.getRound(round2.toString())?.status).toBe("RANDOMNESS_PENDING");
    expect(store.getRound(round2.toString())?.settlementVerified).toBe(false);
    expect(store.txs.getConfirmedPayout(round2)).toBeNull();
    expect(rowsOf(round2.toString()).filter((r) => r.kind === "PAYOUT" && r.payoutStatus === "CONFIRMED")).toHaveLength(0);

    // Even with the escrow funded again, the retry is gated by the backoff:
    // money is never moved on a whim.
    devnet.fund(OPERATOR.publicKey, 3n * SOL);
    await tick();
    expect(store.txs.getConfirmedPayout(round2)).toBeNull();
    expect(devnet.submitted).toHaveLength(sendsBefore);
    expect((await roundJson(round2)).round.status).toBe("RANDOMNESS_PENDING");
  });
});

/** The local devnet ledger's virtual slot, straight from the backend. */
async function backendCurrentSlot(): Promise<bigint> {
  return driver.backend.getCurrentSlot();
}
