/**
 * Completed-round history must survive a process restart.
 *
 * The bug this pins: `/api/history` used to be a projection of the in-memory
 * `Store.rounds` Map, so every API restart (or Render dyno recycle) presented
 * an empty history while the chain still held every settled round.
 *
 * The test drives the real merge in history.ts against a fake chain that owns
 * real 257-byte `Round` account buffers, and a fake RPC that reports a real
 * escrow balance drop for the payout transaction. The restart is simulated the
 * way it actually happens: the in-memory store is emptied and nothing else is
 * carried over — every field then has to come from the chain or the audit
 * mirror.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PublicKey, type Connection } from "@solana/web3.js";
import { getEscrowPda, getRoundPda, ROUND_SPACE } from "@solana-roulette/verification";
import { ROUND_STATES } from "@solana-roulette/types";
import { store } from "./store.js";
import { buildCompletedHistory, rehydrateCompletedRounds, resetHistoryCache } from "./history.js";
import type { ChainBackend } from "./backend.js";

const PROGRAM_ID = new PublicKey("F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos");
const WINNER = new PublicKey("2h3gwYGLc6nx1RcfBMTJpNcTaA4SFTGUJ4mC2iXGGRwX");
const ESCROW_RENT = 650_240;
const POT = 1_000_000_000n;

interface FakeRound {
  id: bigint;
  status: number;
  pot: bigint;
  participantCount: number;
  tier: number;
  feeBps: number;
  winningTicket: bigint;
  payoutLamports: bigint;
  feeLamports: bigint;
  lockSlot: bigint;
  revealSlot: bigint;
  revealInput: Uint8Array;
}

/**
 * Write a real on-chain `Round` buffer, field for field, at the offsets
 * `decodeRound` reads. Building the bytes (rather than stubbing the decoder)
 * is the point: the rehydration path is proven against the same layout the
 * program writes.
 */
function encodeRound(r: FakeRound): Buffer {
  const b = Buffer.alloc(ROUND_SPACE);
  b.writeBigUInt64LE(r.id, 8);
  b.writeUInt8(r.status, 16);
  getEscrowPda(PROGRAM_ID, r.id)[0].toBuffer().copy(b, 17);
  b.writeBigUInt64LE(r.pot, 49);
  // total_weight (u128 at 57) and randomness (32B at 95) stay zeroed.
  b.writeUInt32LE(r.participantCount, 73);
  b.writeBigUInt64LE(r.lockSlot, 77);
  b.writeBigUInt64LE(r.revealSlot, 85);
  b.writeUInt16LE(r.feeBps, 93);
  // winning_ticket (u128 at 127): low limb then high limb.
  b.writeBigUInt64LE(r.winningTicket & 0xffff_ffff_ffff_ffffn, 127);
  b.writeBigUInt64LE(r.winningTicket >> 64n, 135);
  WINNER.toBuffer().copy(b, 143);
  b.writeBigUInt64LE(r.feeLamports, 175);
  b.writeBigUInt64LE(r.payoutLamports, 183);
  b.writeUInt8(r.tier, 223);
  b.writeUInt8(255, 224);
  Buffer.from(r.revealInput).copy(b, 225);
  return b;
}

const completedRound = (id: bigint, overrides: Partial<FakeRound> = {}): FakeRound => ({
  id,
  status: ROUND_STATES.indexOf("COMPLETED"),
  pot: POT,
  participantCount: 3,
  tier: 0,
  feeBps: 200,
  winningTicket: 208_208_162n,
  payoutLamports: 980_000_000n,
  feeLamports: 20_000_000n,
  lockSlot: 100n,
  revealSlot: 132n,
  revealInput: new Uint8Array(32).fill(0xab),
  ...overrides,
});

/** The escrow balance of a completed round: rent only, pot already paid out. */
const ESCROW_AFTER_PAYOUT = ESCROW_RENT;

interface FakeChain {
  backend: ChainBackend;
  connection: Connection;
  /** signature the fake RPC reports for the payout transaction of a round */
  payoutSignature: (id: bigint) => string;
  calls: { getTransaction: number };
}

function fakeChain(rounds: FakeRound[], counter: bigint): FakeChain {
  const byId = new Map(rounds.map((r) => [r.id.toString(), r]));
  const calls = { getTransaction: 0 };
  const payoutSignature = (id: bigint) => `payout-sig-${id.toString()}`;

  const connection = {
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      return keys.map((k) => {
        for (const [idStr, r] of byId) {
          if (getRoundPda(PROGRAM_ID, BigInt(idStr))[0].equals(k)) {
            return { data: encodeRound(r), lamports: 1_955_800, owner: PROGRAM_ID, executable: false, rentEpoch: 0 };
          }
        }
        return null;
      });
    },
    async getSignaturesForAddress(address: PublicKey) {
      // Only the payout of a COMPLETED round touched the escrow downward.
      const round = [...byId.values()].find((r) =>
        getEscrowPda(PROGRAM_ID, r.id)[0].equals(address)
      );
      if (!round || round.status !== ROUND_STATES.indexOf("COMPLETED")) return [];
      return [
        { signature: payoutSignature(round.id), err: null, slot: 500, blockTime: null },
        // A deposit also references the escrow and must NOT be mistaken for it.
        { signature: `deposit-sig-${round.id.toString()}`, err: null, slot: 499, blockTime: null },
      ];
    },
    async getTransaction(signature: string) {
      calls.getTransaction++;
      const round = [...byId.values()].find((r) => signature === payoutSignature(r.id));
      if (!round) return null;
      const escrow = getEscrowPda(PROGRAM_ID, round.id)[0];
      return {
        slot: 500,
        meta: {
          preBalances: [ESCROW_AFTER_PAYOUT + Number(round.pot)],
          postBalances: [ESCROW_AFTER_PAYOUT],
          err: null,
        },
        transaction: {
          message: { accountKeys: [escrow, PROGRAM_ID] },
        },
      };
    },
  } as unknown as Connection;

  const backend = {
    mode: "chain",
    realFunds: true,
    async getRound(id: bigint) {
      const r = byId.get(id.toString());
      return r ? decodeForBackend(r) : null;
    },
    async getParticipants() {
      return [];
    },
    async getGlobalConfig() {
      return { roundCounter: counter } as Awaited<ReturnType<ChainBackend["getGlobalConfig"]>>;
    },
    async getCurrentSlot() {
      return 1000n;
    },
    async getRevealBlockhash() {
      return null;
    },
    async getHeadByTier() {
      return [counter, counter, counter];
    },
    async runLifecycle() {
      return null;
    },
    async deposit() {
      return { signature: "", roundId: 0n };
    },
    treasuryAccrued() {
      return 0n;
    },
  } as unknown as ChainBackend;

  return { backend, connection, payoutSignature, calls };
}

/** Same shape the verification package decodes to, for the backend path. */
async function decodeForBackend(r: FakeRound) {
  const { decodeRound } = await import("@solana-roulette/verification");
  return decodeRound(encodeRound(r));
}

/** Empties the in-memory round index exactly as a fresh process would. */
function simulateRestart(): void {
  (store as unknown as { rounds: Map<string, unknown> }).rounds.clear();
}

const deps = (chain: FakeChain) => ({
  backend: chain.backend,
  connection: chain.connection,
  programId: PROGRAM_ID,
  scanLimit: 200,
  payoutScanLimit: 12,
});

describe("completed-round history survives a restart", () => {
  beforeEach(() => {
    resetHistoryCache();
    simulateRestart();
  });
  afterEach(() => {
    resetHistoryCache();
  });

  it("rebuilds completed rounds from the chain when memory is empty", async () => {
    const chain = fakeChain([completedRound(1n), completedRound(2n)], 2n);

    // Nothing in memory: this is the state a restarted process boots into.
    expect(store.listCompletedRounds()).toHaveLength(0);

    const { rounds } = { rounds: await buildCompletedHistory(deps(chain)) };

    expect(rounds.map((r) => r.id)).toEqual(["2", "1"]);
  });

  it("preserves every field the history contract promises", async () => {
    const chain = fakeChain([completedRound(7n)], 7n);
    const [row] = await buildCompletedHistory(deps(chain));

    expect(row).toMatchObject({
      id: "7",
      status: "COMPLETED",
      tier: 0,
      pot: "1000000000",
      feeBps: 200,
      winner: WINNER.toBase58(),
      participantCount: 3,
      winningTicket: "208208162",
      payoutLamports: "980000000",
      feeLamports: "20000000",
      lockSlot: "100",
      revealSlot: "132",
      source: "chain",
    });
    expect(row.randomnessHex).toHaveLength(64);
    expect(row.revealInputHex).toBe("ab".repeat(32));
  });

  it("recovers the payout signature from the escrow balance drop on chain", async () => {
    const chain = fakeChain([completedRound(9n)], 9n);

    const [row] = await buildCompletedHistory(deps(chain));

    expect(row.payoutTxSignature).toBe(chain.payoutSignature(9n));
    expect(row.payoutTxSource).toBe("chain");
    // The escrow provably left with exactly the pot: that is the settlement.
    expect(row.settlementVerified).toBe(true);
    expect(chain.calls.getTransaction).toBeGreaterThan(0);
  });

  it("does not mistake a deposit for the payout", async () => {
    const chain = fakeChain([completedRound(3n)], 3n);
    const [row] = await buildCompletedHistory(deps(chain));
    expect(row.payoutTxSignature).not.toBe("deposit-sig-3");
  });

  it("leaves the payout signature null when the escrow never drained by the pot", async () => {
    // A CANCELLED round: terminal, so it is history, but nothing was paid out.
    const chain = fakeChain([completedRound(4n, { status: ROUND_STATES.indexOf("CANCELLED") })], 4n);

    const [row] = await buildCompletedHistory(deps(chain));

    expect(row.status).toBe("CANCELLED");
    expect(row.payoutTxSignature).toBeNull();
    expect(row.settlementVerified).toBe(false);
    expect(chain.calls.getTransaction).toBe(0);
  });

  it("excludes rounds that are still open", async () => {
    const chain = fakeChain(
      [
        completedRound(1n),
        completedRound(2n, { status: ROUND_STATES.indexOf("OPEN"), pot: 0n, participantCount: 0 }),
        completedRound(3n, { status: ROUND_STATES.indexOf("RANDOMNESS_PENDING") }),
      ],
      3n
    );

    const { rounds } = { rounds: await buildCompletedHistory(deps(chain)) };
    expect(rounds.map((r) => r.id)).toEqual(["1"]);
  });

  it("boot rehydration repopulates the in-memory store", async () => {
    const chain = fakeChain([completedRound(5n), completedRound(6n)], 6n);
    simulateRestart();

    const report = await rehydrateCompletedRounds(deps(chain));

    expect(report.recovered).toBe(2);
    expect(report.highest).toBe("6");
    // Anything else reading the store (admin console) now sees them too.
    expect(store.listCompletedRounds().map((r) => r.id)).toEqual(["6", "5"]);
    expect(store.getRound("5")?.winner).toBe(WINNER.toBase58());
  });

  it("prefers a locally known signature over a chain re-scan", async () => {
    const chain = fakeChain([completedRound(8n)], 8n);
    store.upsertRound({
      id: "8",
      status: "COMPLETED",
      payoutTxSignature: "known-in-memory",
    });
    resetHistoryCache();

    const [row] = await buildCompletedHistory(deps(chain));

    expect(row.payoutTxSignature).toBe("known-in-memory");
    expect(row.payoutTxSource).toBe("store");
    expect(chain.calls.getTransaction).toBe(0);
  });

  it("falls back to memory when the chain has no rounds yet", async () => {
    const chain = fakeChain([], 0n);
    store.upsertRound({ id: "1", status: "COMPLETED", winner: WINNER.toBase58() });

    const rounds = await buildCompletedHistory(deps(chain));

    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.source).toBe("memory");
  });
});
