/**
 * PAYOUT VERIFICATION BRIDGE (chain mode).
 *
 * In chain mode `pay_winners` moves the lamports PROGRAM-SIDE out of the round
 * escrow PDA. These tests pin the guarantee the server enforces: a `pay`
 * result is only returned to the settlement driver when the on-chain
 * transaction provably moved EXACTLY the frozen amounts (winner +payout,
 * treasury +fee, escrow −sum, verified as account balance deltas from the tx
 * metadata). Every failure mode returns null / !ok, so the driver treats the
 * payout as "not proven" and never completes the round on an unproven send.
 *
 * Layer 1 — `checkProgramPayout` (onchain.ts): the verifier itself, fed with
 * hand-built ParsedTransactionWithMeta fixtures.
 * Layer 2 — `createChainBackend().runLifecycle("pay")` (backend.ts): the
 * wiring — the Round account is re-read for the frozen amounts, verification
 * is mandatory, and any unprovable/failed verification collapses to null.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { Keypair, PublicKey, type Connection, type ParsedTransactionWithMeta } from "@solana/web3.js";
import bs58 from "bs58";
import { resolveConfig } from "@solana-roulette/config";
import { fetchRoundAccount, getEscrowPda, type RoundData } from "@solana-roulette/verification";
import { checkProgramPayout } from "./onchain.js";
import { createChainBackend, type ChainBackend } from "./backend.js";
import { buildAndSendLifecycleTx } from "./operator.js";

vi.mock("./operator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./operator.js")>();
  return {
    ...actual,
    buildAndSendLifecycleTx: vi.fn(),
    // Keep the real guard semantics without needing a full AppConfig.
    requireFeeWallet: (cfg: { platformFeeWallet?: string; treasuryPubkey?: string }) => {
      const raw = cfg.platformFeeWallet ?? cfg.treasuryPubkey;
      if (!raw) throw new Error("PLATFORM_FEE_WALLET missing");
      return new PublicKey(raw);
    },
  };
});
vi.mock("@solana-roulette/verification", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana-roulette/verification")>();
  return { ...actual, fetchRoundAccount: vi.fn() };
});

const buildAndSend = vi.mocked(buildAndSendLifecycleTx);
const fetchRound = vi.mocked(fetchRoundAccount);

const PROGRAM_ID = new PublicKey("AAHBk1qbXCzsbiLe7TiXuZNTvNPVtovtC6NWk9tsi6EZ");
/** The REAL escrow PDA the chain backend derives for round 9 of PROGRAM_ID. */
const ESCROW = getEscrowPda(PROGRAM_ID, 9n)[0];
const WINNER = Keypair.fromSeed(new Uint8Array(32).fill(22)).publicKey;
const TREASURY = new PublicKey("6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR");
// Fee payer (permissionless settlement: ANY signer may have paid the fee).
const OPERATOR = Keypair.fromSeed(new Uint8Array(32).fill(11)).publicKey;

/** Anchor discriminator of `pay_winners` (independent of the SDK). */
function payWinnersDisc(): Buffer {
  return createHash("sha256").update("global:pay_winners").digest().subarray(0, 8);
}

const PAYOUT = 9_800_000_000n; // 9.8 SOL
const FEE = 200_000_000n; // 0.2 SOL
const SIGNATURE = "P".repeat(64);

interface FixtureOverrides {
  err?: unknown;
  includeDisc?: boolean;
  omitAccount?: "escrow" | "winner" | "treasury";
  omitBalances?: boolean;
  winnerDelta?: bigint;
  treasuryDelta?: bigint;
  escrowDelta?: bigint;
}

/**
 * Build a parsed pay_winners transaction. The fixture carries REAL anchor
 * discriminator bytes in a raw (unparsed) instruction and REAL pre/post
 * balance arrays, because the verifier checks exactly those two things.
 */
function payTx(opts: FixtureOverrides = {}): ParsedTransactionWithMeta {
  const include = opts.includeDisc !== false;
  const accounts = [
    { label: "feePayer", key: OPERATOR, pre: 100_000_000n, post: 95_000_000n }, // fee payer pays tx fee
    { label: "escrow", key: ESCROW, pre: 10_000_000_000n, post: 10_000_000_000n },
    { label: "winner", key: WINNER, pre: 1_000_000n, post: 1_000_000n },
    { label: "treasury", key: TREASURY, pre: 500_000_000n, post: 500_000_000n },
  ].filter((a) => a.label !== opts.omitAccount);

  // Default deltas: the exact frozen amounts.
  for (const a of accounts) {
    if (a.label === "escrow") a.post += opts.escrowDelta ?? -(PAYOUT + FEE);
    if (a.label === "winner") a.post += opts.winnerDelta ?? PAYOUT;
    if (a.label === "treasury") a.post += opts.treasuryDelta ?? FEE;
  }

  const instructions: Array<Record<string, unknown>> = [];
  if (include) {
    // A raw (PartiallyDecodedInstruction-shaped) instruction: PublicKey
    // programId + base58 data — exactly the shape the RPC returns and the
    // verifier consumes.
    instructions.push({
      programId: PROGRAM_ID,
      data: bs58.encode(payWinnersDisc()),
      accounts: accounts.map((a) => a.key),
    });
  }

  return {
    slot: 4242,
    blockTime: Math.floor(Date.now() / 1000),
    meta: {
      err: opts.err ?? null,
      fee: 5_000,
      logMessages: ["Program roulette: pay_winners invoked"],
      // Balance metadata is a top-level array of numbers (RPC shape).
      ...(opts.omitBalances
        ? {}
        : {
            preBalances: accounts.map((a) => Number(a.pre)),
            postBalances: accounts.map((a) => Number(a.post)),
          }),
      innerInstructions: [],
    },
    transaction: {
      signatures: [SIGNATURE],
      message: {
        accountKeys: accounts.map((a) => ({ pubkey: a.key, signer: false, writable: true })),
        instructions,
        recentBlockhash: "11111111111111111111111111111111",
      },
    },
  } as unknown as ParsedTransactionWithMeta;
}

function fakeConnection(tx: ParsedTransactionWithMeta | null): Connection {
  return { getParsedTransaction: async () => tx } as unknown as Connection;
}

function makeRound(id: bigint, over: Partial<RoundData> = {}): RoundData {
  return {
    id,
    status: "RANDOMNESS_PENDING",
    escrow: ESCROW,
    pot: PAYOUT + FEE,
    totalWeight: PAYOUT + FEE,
    participantCount: 2,
    lockSlot: 1n,
    revealSlot: 2n,
    feeBps: 200,
    randomness: new Uint8Array(32),
    winningTicket: 0n,
    winner: WINNER,
    feeLamports: FEE,
    payoutLamports: PAYOUT,
    payoutAccount: new Uint8Array(32),
    tier: 0,
    bump: 255,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Layer 1: checkProgramPayout
// ---------------------------------------------------------------------------

describe("checkProgramPayout (balance-delta verification)", () => {
  it("accepts a payout that moved exactly the frozen amounts", async () => {
    const check = await checkProgramPayout(fakeConnection(payTx()), {
      signature: SIGNATURE,
      programId: PROGRAM_ID,
      escrow: ESCROW,
      winner: WINNER,
      treasury: TREASURY,
      payoutLamports: PAYOUT,
      feeLamports: FEE,
    });
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.escrowDebit).toBe(PAYOUT + FEE);
      expect(check.slot).toBe(4242);
    }
  });

  it("rejects a missing transaction (tx_not_found)", async () => {
    const check = await checkProgramPayout(fakeConnection(null), {
      signature: SIGNATURE,
      programId: PROGRAM_ID,
      escrow: ESCROW,
      winner: WINNER,
      treasury: TREASURY,
      payoutLamports: PAYOUT,
      feeLamports: FEE,
    });
    expect(check).toMatchObject({ ok: false, code: "tx_not_found" });
  });

  it("rejects a transaction that failed on chain", async () => {
    const check = await checkProgramPayout(fakeConnection(payTx({ err: { InstructionError: [0, 1] } })), {
      signature: SIGNATURE,
      programId: PROGRAM_ID,
      escrow: ESCROW,
      winner: WINNER,
      treasury: TREASURY,
      payoutLamports: PAYOUT,
      feeLamports: FEE,
    });
    expect(check).toMatchObject({ ok: false, code: "tx_failed_on_chain" });
  });

  it("rejects an RPC failure with rpc_error (never throws)", async () => {
    const conn = {
      getParsedTransaction: async () => {
        throw new Error("429 Too Many Requests");
      },
    } as unknown as Connection;
    const check = await checkProgramPayout(conn, {
      signature: SIGNATURE,
      programId: PROGRAM_ID,
      escrow: ESCROW,
      winner: WINNER,
      treasury: TREASURY,
      payoutLamports: PAYOUT,
      feeLamports: FEE,
    });
    expect(check).toMatchObject({ ok: false, code: "rpc_error" });
    if (!check.ok) expect(check.detail).toContain("429");
  });

  it("rejects a transaction that is not this program's pay_winners", async () => {
    const check = await checkProgramPayout(fakeConnection(payTx({ includeDisc: false })), {
      signature: SIGNATURE,
      programId: PROGRAM_ID,
      escrow: ESCROW,
      winner: WINNER,
      treasury: TREASURY,
      payoutLamports: PAYOUT,
      feeLamports: FEE,
    });
    expect(check).toMatchObject({ ok: false, code: "no_program_payout" });
  });

  it("rejects when the escrow is not part of the transaction", async () => {
    const check = await checkProgramPayout(fakeConnection(payTx({ omitAccount: "escrow" })), {
      signature: SIGNATURE,
      programId: PROGRAM_ID,
      escrow: ESCROW,
      winner: WINNER,
      treasury: TREASURY,
      payoutLamports: PAYOUT,
      feeLamports: FEE,
    });
    expect(check).toMatchObject({ ok: false, code: "escrow_not_in_tx" });
  });

  it("rejects when the winner is not part of the transaction", async () => {
    const check = await checkProgramPayout(fakeConnection(payTx({ omitAccount: "winner" })), {
      signature: SIGNATURE,
      programId: PROGRAM_ID,
      escrow: ESCROW,
      winner: WINNER,
      treasury: TREASURY,
      payoutLamports: PAYOUT,
      feeLamports: FEE,
    });
    expect(check).toMatchObject({ ok: false, code: "winner_not_in_tx" });
  });

  it("rejects when the treasury is not part of the transaction", async () => {
    const check = await checkProgramPayout(fakeConnection(payTx({ omitAccount: "treasury" })), {
      signature: SIGNATURE,
      programId: PROGRAM_ID,
      escrow: ESCROW,
      winner: WINNER,
      treasury: TREASURY,
      payoutLamports: PAYOUT,
      feeLamports: FEE,
    });
    expect(check).toMatchObject({ ok: false, code: "treasury_not_in_tx" });
  });

  it("rejects transactions without balance metadata", async () => {
    const check = await checkProgramPayout(fakeConnection(payTx({ omitBalances: true })), {
      signature: SIGNATURE,
      programId: PROGRAM_ID,
      escrow: ESCROW,
      winner: WINNER,
      treasury: TREASURY,
      payoutLamports: PAYOUT,
      feeLamports: FEE,
    });
    expect(check).toMatchObject({ ok: false, code: "missing_balance_meta" });
  });

  it("rejects a winner credit that is off by one lamport", async () => {
    const check = await checkProgramPayout(
      fakeConnection(payTx({ winnerDelta: PAYOUT - 1n })),
      {
        signature: SIGNATURE,
        programId: PROGRAM_ID,
        escrow: ESCROW,
        winner: WINNER,
        treasury: TREASURY,
        payoutLamports: PAYOUT,
        feeLamports: FEE,
      }
    );
    expect(check).toMatchObject({ ok: false, code: "winner_amount_mismatch" });
  });

  it("rejects a treasury credit that is not the frozen fee", async () => {
    const check = await checkProgramPayout(
      fakeConnection(payTx({ treasuryDelta: FEE + 5n })),
      {
        signature: SIGNATURE,
        programId: PROGRAM_ID,
        escrow: ESCROW,
        winner: WINNER,
        treasury: TREASURY,
        payoutLamports: PAYOUT,
        feeLamports: FEE,
      }
    );
    expect(check).toMatchObject({ ok: false, code: "treasury_amount_mismatch" });
  });

  it("rejects an escrow debit that does not equal payout + fee", async () => {
    // Winner/treasury correct, but the escrow also lost an extra lamport —
    // the unaccounted lamport is exactly what this check exists to catch.
    const check = await checkProgramPayout(
      fakeConnection(payTx({ escrowDelta: -(PAYOUT + FEE + 1n) })),
      {
        signature: SIGNATURE,
        programId: PROGRAM_ID,
        escrow: ESCROW,
        winner: WINNER,
        treasury: TREASURY,
        payoutLamports: PAYOUT,
        feeLamports: FEE,
      }
    );
    expect(check).toMatchObject({ ok: false, code: "escrow_outflow_mismatch" });
  });

  it("rejects a WRONG recipient receiving the fee (configured treasury absent)", async () => {
    // An impostor sits in the treasury's slot; the configured treasury is not
    // part of the transaction at all. Verification must refuse — this is the
    // defense-in-depth case (pay_winners itself pins treasury == config, so
    // the program cannot produce this shape).
    const impostor = Keypair.fromSeed(new Uint8Array(32).fill(77)).publicKey;
    const tx = payTx({ treasuryDelta: 0n });
    const keys = tx.transaction.message.accountKeys as Array<{ pubkey: PublicKey }>;
    const idx = keys.findIndex((k) => k.pubkey.equals(TREASURY));
    keys[idx]!.pubkey = impostor;
    const check = await checkProgramPayout(fakeConnection(tx), {
      signature: SIGNATURE,
      programId: PROGRAM_ID,
      escrow: ESCROW,
      winner: WINNER,
      treasury: TREASURY,
      payoutLamports: PAYOUT,
      feeLamports: FEE,
    });
    expect(check).toMatchObject({ ok: false, code: "treasury_not_in_tx" });
  });
});

// ---------------------------------------------------------------------------
// Layer 2: chain backend wiring
// ---------------------------------------------------------------------------

function backendWith(conn: Connection): ChainBackend {
  const cfg = resolveConfig({} as NodeJS.ProcessEnv);
  return createChainBackend(conn, PROGRAM_ID, cfg);
}

describe("chain backend runLifecycle('pay') — verification bridge wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the pay result only after a verified payout", async () => {
    buildAndSend.mockResolvedValue({
      signature: SIGNATURE,
      roundId: 9n,
      winner: WINNER.toBase58(),
      payoutLamports: PAYOUT.toString(),
      feeLamports: FEE.toString(),
    });
    fetchRound.mockResolvedValue(makeRound(9n));
    const backend = backendWith(fakeConnection(payTx()));

    const result = await backend.runLifecycle("pay", { roundId: 9n });
    expect(result).not.toBeNull();
    expect(result!.signature).toBe(SIGNATURE);
    // The frozen amounts came from the RE-READ Round account, not the operator result.
    expect(fetchRound).toHaveBeenCalledWith(expect.anything(), PROGRAM_ID, 9n);
  });

  it("collapses a verification failure to null (round never completes on an unproven payout)", async () => {
    buildAndSend.mockResolvedValue({
      signature: SIGNATURE,
      roundId: 9n,
      winner: WINNER.toBase58(),
      payoutLamports: PAYOUT.toString(),
      feeLamports: FEE.toString(),
    });
    fetchRound.mockResolvedValue(makeRound(9n));
    // Winner got 1 lamport too little: verification MUST fail.
    const backend = backendWith(fakeConnection(payTx({ winnerDelta: PAYOUT - 1n })));

    const result = await backend.runLifecycle("pay", { roundId: 9n });
    expect(result).toBeNull();
  });

  it("refuses to verify when the Round account cannot be re-read", async () => {
    buildAndSend.mockResolvedValue({ signature: SIGNATURE, roundId: 9n });
    fetchRound.mockResolvedValue(null);
    const backend = backendWith(fakeConnection(payTx()));

    const result = await backend.runLifecycle("pay", { roundId: 9n });
    expect(result).toBeNull();
  });

  it("refuses to verify when no winner is frozen on the re-read round", async () => {
    buildAndSend.mockResolvedValue({ signature: SIGNATURE, roundId: 9n });
    fetchRound.mockResolvedValue(makeRound(9n, { winner: PublicKey.default }));
    const backend = backendWith(fakeConnection(payTx()));

    const result = await backend.runLifecycle("pay", { roundId: 9n });
    expect(result).toBeNull();
  });

  it("does not verify or read the round when the operator sent nothing (null result)", async () => {
    buildAndSend.mockResolvedValue(null);
    const backend = backendWith(fakeConnection(payTx()));

    const result = await backend.runLifecycle("pay", { roundId: 9n });
    expect(result).toBeNull();
    expect(fetchRound).not.toHaveBeenCalled();
  });

  it("does not touch the verification bridge for non-pay lifecycle actions", async () => {
    buildAndSend.mockResolvedValue({ signature: SIGNATURE, roundId: 9n });
    fetchRound.mockResolvedValue(makeRound(9n));
    const backend = backendWith(fakeConnection(payTx()));

    const result = await backend.runLifecycle("lock", { roundId: 9n });
    expect(result).not.toBeNull();
    expect(fetchRound).not.toHaveBeenCalled();
  });

  it("collapses a verification RPC crash to null instead of throwing", async () => {
    buildAndSend.mockResolvedValue({
      signature: SIGNATURE,
      roundId: 9n,
      winner: WINNER.toBase58(),
      payoutLamports: PAYOUT.toString(),
      feeLamports: FEE.toString(),
    });
    fetchRound.mockResolvedValue(makeRound(9n));
    const conn = {
      getParsedTransaction: async () => {
        throw new Error("connection reset");
      },
    } as unknown as Connection;
    const backend = backendWith(conn);

    const result = await backend.runLifecycle("pay", { roundId: 9n });
    expect(result).toBeNull();
  });
});
