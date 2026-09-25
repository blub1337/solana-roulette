/**
 * Real payout flow.
 *
 * The winner is paid with an actual System transfer signed by the server-side
 * operator key. These tests decode the transaction the server would broadcast
 * and feed the result back through the same verification the runtime uses, so
 * "payout only from confirmed deposits", "never twice" and "never marked done
 * before the chain confirms" are all pinned.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type Connection,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { resolveConfig } from "@solana-roulette/config";
import type { ChainBackend } from "./backend.js";
import type { RoundData, ParticipantData, GlobalConfigData } from "@solana-roulette/verification";
import { store } from "./store.js";
import { depositKey, payoutKey } from "./txLedger.js";
import { ensureRoundPaid } from "./payout.js";
import type { Custody } from "./custody.js";
import { sendAndConfirmTransaction } from "@solana/web3.js";

vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return { ...actual, sendAndConfirmTransaction: vi.fn() };
});

const sendMock = vi.mocked(sendAndConfirmTransaction);

const FEE_WALLET = new PublicKey("6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR");
const PROGRAM_ID = new PublicKey("AAHBk1qbXCzsbiLe7TiXuZNTvNPVtovtC6NWk9tsi6EZ");
const OPERATOR = Keypair.fromSeed(new Uint8Array(32).fill(11));
const WINNER = Keypair.fromSeed(new Uint8Array(32).fill(22)).publicKey;
const SIGNATURE = "P".repeat(64);

/** Every case gets its own signature: a signature may never be reused. */
let sigCounter = 0;
function nextSignature(): string {
  sigCounter += 1;
  return sigCounter.toString().padStart(64, "0");
}

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Decode a real Transaction into the parsed shape the verifier consumes. */
function parsedFromTransaction(
  tx: Transaction,
  opts: { err?: unknown; extraTransfer?: { to: PublicKey; lamports: bigint } } = {}
): ParsedTransactionWithMeta {
  const keys: PublicKey[] = [];
  const push = (key: PublicKey) => {
    if (!keys.some((k) => k.equals(key))) keys.push(key);
  };
  push(tx.feePayer ?? OPERATOR.publicKey);
  for (const ix of tx.instructions) for (const k of ix.keys) push(k.pubkey);
  if (opts.extraTransfer) push(opts.extraTransfer.to);

  const instructions = tx.instructions
    .map((ix) => {
      if (!ix.programId.equals(SystemProgram.programId)) return null;
      if (ix.data.length !== 12) return null;
      const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
      if (view.getUint32(0, true) !== 2) return null; // SystemProgram.transfer
      return {
        program: "system",
        parsed: {
          type: "transfer",
          info: {
            source: ix.keys[0]!.pubkey.toBase58(),
            destination: ix.keys[1]!.pubkey.toBase58(),
            lamports: Number(view.getBigUint64(4, true)),
          },
        },
      };
    })
    .filter(Boolean) as Array<Record<string, unknown>>;

  if (opts.extraTransfer) {
    instructions.push({
      program: "system",
      parsed: {
        type: "transfer",
        info: {
          source: OPERATOR.publicKey.toBase58(),
          destination: opts.extraTransfer.to.toBase58(),
          lamports: Number(opts.extraTransfer.lamports),
        },
      },
    });
  }

  return {
    slot: 42,
    blockTime: Math.floor(Date.now() / 1000),
    signature: SIGNATURE,
    meta: { err: opts.err ?? null, fee: 5000, logMessages: [], innerInstructions: [] },
    transaction: {
      signatures: [SIGNATURE],
      message: {
        accountKeys: keys.map((pubkey) => ({ pubkey, signer: false, writable: true })),
        instructions,
        recentBlockhash: "11111111111111111111111111111111",
      },
    },
  } as unknown as ParsedTransactionWithMeta;
}

function makeRound(id: bigint): RoundData {
  return {
    id,
    status: "RANDOMNESS_PENDING",
    escrow: OPERATOR.publicKey,
    pot: 0n,
    totalWeight: 0n,
    participantCount: 0,
    lockSlot: 1n,
    revealSlot: 2n,
    feeBps: 750,
    randomness: new Uint8Array(32),
    winningTicket: 0n,
    winner: WINNER,
    feeLamports: 0n,
    payoutLamports: 0n,
    payoutAccount: new Uint8Array(32),
    tier: 0,
    bump: 255,
  };
}

function backend(): ChainBackend {
  return {
    mode: "local",
    realFunds: false,
    async getRound(): Promise<RoundData | null> {
      return null;
    },
    async getParticipants(): Promise<ParticipantData[]> {
      return [];
    },
    async getGlobalConfig(): Promise<GlobalConfigData | null> {
      return null;
    },
    async getCurrentSlot() {
      return 10n;
    },
    async getRevealBlockhash() {
      return null;
    },
    async getHeadByTier() {
      return [1n, 0n, 0n];
    },
    async runLifecycle() {
      return null;
    },
    async deposit() {
      throw new Error("not used");
    },
    treasuryAccrued() {
      return 0n;
    },
  };
}

function custody(escrowBalance: bigint): Custody {
  return {
    network: "devnet",
    cluster: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
    escrow: OPERATOR.publicKey,
    feeWallet: FEE_WALLET,
    signer: OPERATOR,
    signerAddress: OPERATOR.publicKey.toBase58(),
    ready: true,
    reason: "test",
  };
}

interface Case {
  deps: { backend: ChainBackend; connection: Connection; custody: Custody; cfg: ReturnType<typeof resolveConfig> };
  sent: Transaction[];
}

function setup(opts: { escrowBalance: bigint; onSend?: (tx: Transaction) => ParsedTransactionWithMeta | null }): Case {
  const sent: Transaction[] = [];
  let parsed: ParsedTransactionWithMeta | null = null;
  const signature = nextSignature();

  sendMock.mockImplementation((async (_conn: Connection, tx: Transaction) => {
    sent.push(tx);
    parsed = opts.onSend ? opts.onSend(tx) : parsedFromTransaction(tx);
    return signature;
  }) as unknown as typeof sendAndConfirmTransaction);

  const connection = {
    getBalance: async () => Number(opts.escrowBalance),
    getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1000 }),
    getParsedTransaction: async () => parsed,
    getSlot: async () => 42,
  } as unknown as Connection;

  const cfg = resolveConfig({ PLATFORM_FEE_WALLET: FEE_WALLET.toBase58() } as NodeJS.ProcessEnv);
  return { deps: { backend: backend(), connection, custody: custody(opts.escrowBalance), cfg }, sent };
}

/** Record CONFIRMED deposits so the pot is backed by real transfers. */
function fundRound(roundId: bigint, amounts: bigint[]): bigint {
  amounts.forEach((amount, i) => {
    const wallet = Keypair.fromSeed(new Uint8Array(32).fill(40 + i)).publicKey.toBase58();
    const { tx } = store.txs.begin({
      kind: "DEPOSIT",
      idempotencyKey: depositKey(roundId, wallet),
      roundId: roundId.toString(),
      tier: 0,
      wallet,
      recipient: OPERATOR.publicKey.toBase58(),
      network: "devnet",
      depositAmountLamports: amount.toString(),
    });
    // Unique 64-char signature per deposit (signatures are globally unique).
    const signature = `${roundId.toString()}${i}`.padStart(64, "0");
    store.txs.settle(tx.id, "CONFIRMED", { signature });
  });
  return amounts.reduce((a, b) => a + b, 0n);
}

let caseCounter = 500;
function nextRound(): bigint {
  caseCounter += 1;
  return BigInt(caseCounter);
}

beforeEach(() => {
  sendMock.mockReset();
});

describe("real devnet payout", () => {
  it("sends fee + payout in one real transfer and marks CONFIRMED only after verification", async () => {
    const roundId = nextRound();
    fundRound(roundId, [LAMPORTS_PER_SOL]);
    const { deps, sent } = setup({ escrowBalance: 5n * LAMPORTS_PER_SOL });

    const outcome = await ensureRoundPaid(deps, { roundId, tier: 0, winner: WINNER.toBase58() });
    expect(outcome.status).toBe("CONFIRMED");
    expect(sent).toHaveLength(1);

    // 7.5% fee to the fee wallet + 92.5% to the winner, in ONE transaction.
    expect(outcome.feeLamports).toBe(75_000_000n);
    expect(outcome.payoutLamports).toBe(925_000_000n);
    const parsed = parsedFromTransaction(sent[0]!);
    const transfers = (parsed.transaction.message.instructions as Array<{ parsed: { info: { source: string; destination: string; lamports: number } } }>).map(
      (ix) => ix.parsed.info
    );
    expect(transfers).toHaveLength(2);
    expect(transfers[0]).toMatchObject({ destination: FEE_WALLET.toBase58(), lamports: 75_000_000 });
    expect(transfers[1]).toMatchObject({ destination: WINNER.toBase58(), lamports: 925_000_000 });
    expect(transfers.every((t) => t.source === OPERATOR.publicKey.toBase58())).toBe(true);

    const record = store.txs.getPayout(roundId);
    expect(record?.payoutStatus).toBe("CONFIRMED");
    expect(record?.depositSignature).toBeTruthy();
    expect(String(record?.depositSignature)).toHaveLength(64);
    expect(record?.feeLamports).toBe("75000000");
  });

  it("never pays a round without confirmed deposits", async () => {
    const roundId = nextRound();
    const { deps, sent } = setup({ escrowBalance: 5n * LAMPORTS_PER_SOL });
    const outcome = await ensureRoundPaid(deps, { roundId, tier: 0, winner: WINNER.toBase58() });
    expect(outcome.status).toBe("FAILED");
    expect(sent).toHaveLength(0);
    expect(store.txs.getConfirmedPayout(roundId)).toBeNull();
  });

  it("pays the pot from confirmed deposits, not from an unconfirmed one", async () => {
    const roundId = nextRound();
    fundRound(roundId, [400_000_000n]);
    // A PENDING deposit must not inflate the pot.
    const ghost = Keypair.fromSeed(new Uint8Array(32).fill(99)).publicKey.toBase58();
    store.txs.begin({
      kind: "DEPOSIT",
      idempotencyKey: depositKey(roundId, ghost),
      roundId: roundId.toString(),
      tier: 0,
      wallet: ghost,
      recipient: OPERATOR.publicKey.toBase58(),
      network: "devnet",
      depositAmountLamports: "600000000",
    });

    const { deps } = setup({ escrowBalance: 5n * LAMPORTS_PER_SOL });
    const outcome = await ensureRoundPaid(deps, { roundId, tier: 0, winner: WINNER.toBase58() });
    expect(outcome.status).toBe("CONFIRMED");
    expect(outcome.payoutLamports + outcome.feeLamports).toBe(400_000_000n);
    expect(outcome.feeLamports).toBe(30_000_000n); // 7.5% of 0.4 SOL, floored
  });

  it("never pays the same round twice", async () => {
    const roundId = nextRound();
    fundRound(roundId, [LAMPORTS_PER_SOL]);
    const { deps, sent } = setup({ escrowBalance: 5n * LAMPORTS_PER_SOL });

    const first = await ensureRoundPaid(deps, { roundId, tier: 0, winner: WINNER.toBase58() });
    const second = await ensureRoundPaid(deps, { roundId, tier: 0, winner: WINNER.toBase58() });
    expect(first.status).toBe("CONFIRMED");
    expect(second.status).toBe("CONFIRMED");
    expect(second.status === "CONFIRMED" && second.alreadyPaid).toBe(true);
    expect(sent).toHaveLength(1);
    expect(store.txs.getPayout(roundId)?.payoutStatus).toBe("CONFIRMED");
  });

  it("refuses to broadcast when the escrow cannot fund the pot", async () => {
    const roundId = nextRound();
    fundRound(roundId, [LAMPORTS_PER_SOL]);
    const { deps, sent } = setup({ escrowBalance: 100_000_000n }); // 0.1 SOL only
    const outcome = await ensureRoundPaid(deps, { roundId, tier: 0, winner: WINNER.toBase58() });
    expect(outcome.status).toBe("FAILED");
    expect(sent).toHaveLength(0);
    expect(store.txs.getPayout(roundId)?.payoutStatus).toBe("FAILED");
    expect(store.txs.getPayout(roundId)?.lastError).toMatch(/escrow balance/);
  });

  it("does not mark the payout done when the chain reports an error", async () => {
    const roundId = nextRound();
    fundRound(roundId, [LAMPORTS_PER_SOL]);
    const { deps } = setup({
      escrowBalance: 5n * LAMPORTS_PER_SOL,
      onSend: (tx) => parsedFromTransaction(tx, { err: { InstructionError: [0, "Custom"] } }),
    });
    const outcome = await ensureRoundPaid(deps, { roundId, tier: 0, winner: WINNER.toBase58() });
    expect(outcome.status).toBe("FAILED");
    expect(store.txs.getConfirmedPayout(roundId)).toBeNull();
  });

  it("rejects a transaction that moves more than fee + payout", async () => {
    const roundId = nextRound();
    fundRound(roundId, [LAMPORTS_PER_SOL]);
    const thief = Keypair.fromSeed(new Uint8Array(32).fill(77)).publicKey;
    const { deps } = setup({
      escrowBalance: 5n * LAMPORTS_PER_SOL,
      onSend: (tx) => parsedFromTransaction(tx, { extraTransfer: { to: thief, lamports: 1_000_000n } }),
    });
    const outcome = await ensureRoundPaid(deps, { roundId, tier: 0, winner: WINNER.toBase58() });
    expect(outcome.status).toBe("FAILED");
    expect(store.txs.getConfirmedPayout(roundId)).toBeNull();
  });

  it("skips silently when custody is not configured", async () => {
    const roundId = nextRound();
    fundRound(roundId, [LAMPORTS_PER_SOL]);
    const { deps, sent } = setup({ escrowBalance: 5n * LAMPORTS_PER_SOL });
    deps.custody = { ...deps.custody, ready: false, reason: "no signer", signer: null, signerAddress: null };
    const outcome = await ensureRoundPaid(deps, { roundId, tier: 0, winner: WINNER.toBase58() });
    expect(outcome.status).toBe("SKIPPED");
    expect(sent).toHaveLength(0);
  });

  it("uses one idempotency key per attempt so retries never double-pay", async () => {
    const roundId = nextRound();
    fundRound(roundId, [LAMPORTS_PER_SOL]);
    // First attempt fails on chain; the next tick must open attempt 2.
    const { deps } = setup({
      escrowBalance: 5n * LAMPORTS_PER_SOL,
      onSend: (tx) => parsedFromTransaction(tx, { err: { InstructionError: [0, "Custom"] } }),
    });
    await ensureRoundPaid(deps, { roundId, tier: 0, winner: WINNER.toBase58() });
    expect(store.txs.getPayout(roundId, 1)?.payoutStatus).toBe("FAILED");

    const retry = setup({ escrowBalance: 5n * LAMPORTS_PER_SOL });
    const outcome = await ensureRoundPaid(
      { ...retry.deps, custody: deps.custody },
      { roundId, tier: 0, winner: WINNER.toBase58() }
    );
    // The backoff gate holds the retry until it is due.
    expect(["PENDING", "CONFIRMED"]).toContain(outcome.status);
    if (outcome.status === "CONFIRMED") {
      expect(store.txs.getPayout(roundId)?.payoutStatus).toBe("CONFIRMED");
      const record = store.txs.getPayout(roundId)!;
      expect(store.txs.bySignature(record.depositSignature!)?.idempotencyKey).toBe(payoutKey(roundId, 2));
    }
  });
});
