import { describe, it, expect, vi, beforeEach } from "vitest";
import { verifySubmittedTransaction } from "./verifyTx.js";
import { store } from "./store.js";
import { PublicKey } from "@solana/web3.js";
import { getEscrowPda, getRoundPda } from "@solana-roulette/verification";

const PROGRAM_ID = PublicKey.default; // deterministic for tests
const ROUND_ID = 1n;

function escrowKey(): PublicKey {
  // Use the same derivation as production code.
  return getEscrowPda(PROGRAM_ID, ROUND_ID)[0];
}

/** Encode a minimal valid OPEN Round account for round 1 (status OPEN, tier 0, no deposits). */
function roundBytes(): Uint8Array {
  const [roundPk] = getRoundPda(PROGRAM_ID, ROUND_ID);
  const [escrowPk] = getEscrowPda(PROGRAM_ID, ROUND_ID);
  // space = 8 + 8 + 1 + 32 + 8 + 16 + 4 + 8 + 8 + 2 + 32 + 16 + 32 + 8 + 8 + 32 + 1 + 1 (incl. payout_account + tier)
  const space = 8 + 8 + 1 + 32 + 8 + 16 + 4 + 8 + 8 + 2 + 32 + 16 + 32 + 8 + 8 + 32 + 1 + 1;
  const buf = Buffer.alloc(space);
  const v = new DataView(buf.buffer);
  let o = 8;
  buf.writeBigUInt64LE(ROUND_ID, o); o += 8; // id
  buf.writeUInt8(0, o); o += 1; // status = OPEN
  Buffer.from(escrowPk.toBytes()).copy(buf, o); o += 32; // escrow
  buf.writeBigUInt64LE(0n, o); o += 8; // pot
  // total_weight u128 = 0
  o += 16;
  v.setUint32(o, 0, true); o += 4; // participant_count
  buf.writeBigUInt64LE(0n, o); o += 8; // lock_slot
  buf.writeBigUInt64LE(0n, o); o += 8; // reveal_slot
  v.setUint16(o, 200, true); o += 2; // fee_bps
  o += 32; // randomness zeros
  o += 16; // winning_ticket zeros
  Buffer.from(PublicKey.default.toBytes()).copy(buf, o); o += 32; // winner
  buf.writeBigUInt64LE(0n, o); o += 8; // fee_lamports
  buf.writeBigUInt64LE(0n, o); o += 8; // payout_lamports
  o += 32; // payout_account (zeroed)
  buf.writeUInt8(0, o); o += 1; // tier = 0 (1-SOL lane)
  buf.writeUInt8(255, o); // bump
  void roundPk;
  return new Uint8Array(buf);
}

function fakeTx(overrides?: {
  err?: unknown;
  from?: string;
  transfers?: Array<{ from: string; to: string; lamports: number }>;
}) {
  const escrow = escrowKey().toBase58();
  const from = overrides?.from ?? "11111111111111111111111111111112";
  return {
    slot: 12345,
    meta: { err: overrides?.err ?? null },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: new PublicKey(from) },
          { pubkey: escrowKey() },
        ],
        instructions:
          overrides?.transfers?.map((t) => ({
            program: "system",
            parsed: { type: "transfer", info: { source: t.from, destination: t.to, lamports: t.lamports } },
          })) ?? [],
      },
    },
  };
}

describe("verifySubmittedTransaction", () => {
  beforeEach(() => {
    store.txs.length = 0;
  });

  it("rejects when tx not found", async () => {
    const connection = {
      getParsedTransaction: vi.fn().mockResolvedValue(null),
      getAccountInfo: vi.fn(),
    } as never;
    const res = await verifySubmittedTransaction({
      connection,
      programId: PROGRAM_ID,
      signature: "1".repeat(64),
      kind: "deposit",
      expectedRoundId: ROUND_ID,
    });
    expect(res.status).toBe(404);
  });

  it("rejects failed transactions", async () => {
    const connection = {
      getParsedTransaction: vi.fn().mockResolvedValue(fakeTx({ err: { InstructionError: [0, "Custom"] } })),
    } as never;
    const res = await verifySubmittedTransaction({
      connection,
      programId: PROGRAM_ID,
      signature: "2".repeat(64),
      kind: "deposit",
      expectedRoundId: ROUND_ID,
    });
    expect(res.status).toBe(422);
  });

  it("rejects tx with no transfer to escrow", async () => {
    const connection = {
      getParsedTransaction: vi.fn().mockResolvedValue(fakeTx({ transfers: [] })),
    } as never;
    const res = await verifySubmittedTransaction({
      connection,
      programId: PROGRAM_ID,
      signature: "3".repeat(64),
      kind: "deposit",
      expectedRoundId: ROUND_ID,
    });
    expect(res.status).toBe(422);
  });

  it("verifies a valid deposit and reports the ACTUAL amount", async () => {
    const escrow = escrowKey().toBase58();
    const connection = {
      getParsedTransaction: vi.fn().mockResolvedValue(
        fakeTx({ transfers: [{ from: "11111111111111111111111111111112", to: escrow, lamports: 123456789 }] })
      ),
      getAccountInfo: vi.fn().mockImplementation((key: PublicKey) => {
        const [roundPk] = getRoundPda(PROGRAM_ID, ROUND_ID);
        if (key.equals(roundPk)) {
          return Promise.resolve({ lamports: 123456789, data: roundBytes() });
        }
        return Promise.resolve({ lamports: 123456789, data: new Uint8Array(0) });
      }),
    } as never;
    const res = await verifySubmittedTransaction({
      connection,
      programId: PROGRAM_ID,
      signature: "4".repeat(64),
      kind: "deposit",
      expectedRoundId: ROUND_ID,
    });
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).amountLamports).toBe("123456789");
    expect((res.body as Record<string, unknown>).wallet).toBe("11111111111111111111111111111112");
  });

  it("is idempotent: duplicate signature returns 409", async () => {
    const escrow = escrowKey().toBase58();
    const sig = "5".repeat(64);
    // A distinct wallet: entries are unique per (round, wallet), so a second
    // deposit by the SAME wallet is a duplicate deposit, not a new record.
    const wallet = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    const connection = {
      getParsedTransaction: vi.fn().mockResolvedValue(
        fakeTx({ from: wallet, transfers: [{ from: wallet, to: escrow, lamports: 1000 }] })
      ),
      getAccountInfo: vi.fn().mockImplementation((key: PublicKey) => {
        const [roundPk] = getRoundPda(PROGRAM_ID, ROUND_ID);
        if (key.equals(roundPk)) {
          return Promise.resolve({ lamports: 1000, data: roundBytes() });
        }
        return Promise.resolve({ lamports: 1000, data: new Uint8Array(0) });
      }),
    } as never;
    const first = await verifySubmittedTransaction({
      connection,
      programId: PROGRAM_ID,
      signature: sig,
      kind: "deposit",
      expectedRoundId: ROUND_ID,
    });
    expect(first.status).toBe(200);
    const second = await verifySubmittedTransaction({
      connection,
      programId: PROGRAM_ID,
      signature: sig,
      kind: "deposit",
      expectedRoundId: ROUND_ID,
    });
    expect(second.status).toBe(409);
  });
});
