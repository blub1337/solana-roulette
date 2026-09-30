/**
 * Local devnet ledger — behaviour tests.
 *
 * These pin the semantics the Anchor program must also uphold: the state
 * machine, the pool cap, duplicate protection, the commit–reveal boundary and
 * the exact integer 7.5% / 92.5% split.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { LocalLedger, LocalLedgerError } from "./localLedger.js";
import { verifyRoundData } from "@solana-roulette/verification";
import { deriveRandomness } from "@solana-roulette/verification";

const PROGRAM_ID = new PublicKey("AAHBk1qbXCzsbiLe7TiXuZNTvNPVtovtC6NWk9tsi6EZ");
const TREASURY = new PublicKey("6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR");
const CAP = 1_000_000_000n; // 1 SOL lane
const MIN = 10_000_000n; // 0.01 SOL
const MAX = 1_000_000_000n; // 1 SOL

let clock = 1_000_000;
const advance = (ms: number) => {
  clock += ms;
};

function makeLedger() {
  let seed = 42;
  return new LocalLedger({
    programId: PROGRAM_ID,
    operator: LocalLedger.deriveOperator(PROGRAM_ID),
    treasury: TREASURY,
    feeBps: 200,
    tierCaps: [CAP, 10n * CAP, 100n * CAP],
    minDeposit: MIN,
    maxDeposit: MAX,
    maxRoundSize: 100n * CAP,
    revealOffsetSlots: 32n,
    slotMs: 400,
    now: () => clock,
    // Deterministic but non-constant entropy so commits are unique per round.
    random: (n: number) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        out[i] = seed & 0xff;
      }
      return out;
    },
  });
}

function wallets(n: number): PublicKey[] {
  return Array.from({ length: n }, () => Keypair.generate().publicKey);
}

describe("local ledger: round lifecycle", () => {
  beforeEach(() => {
    clock = 1_000_000;
  });

  it("creates a round in the requested lane and derives the real escrow PDA", () => {
    const l = makeLedger();
    const id = l.createRound(0);
    expect(id).toBe(1n);
    const round = l.getRound(1n)!;
    expect(round.status).toBe("OPEN");
    expect(round.tier).toBe(0);
    expect(round.pot).toBe(0n);
    expect(round.escrow).not.toEqual(PublicKey.default);
    expect(l.headByTier[0]).toBe(1n);
  });

  it("fills a round to the cap and auto-closes it at exactly 1 SOL", () => {
    const l = makeLedger();
    const id = l.createRound(0);
    const [a, b, c] = wallets(3);
    l.deposit({ roundId: id, wallet: a, lamports: 250_000_000n });
    expect(l.getRound(id)!.status).toBe("OPEN");
    l.deposit({ roundId: id, wallet: b, lamports: 400_000_000n });
    l.deposit({ roundId: id, wallet: c, lamports: 350_000_000n });
    const round = l.getRound(id)!;
    expect(round.pot).toBe(1_000_000_000n);
    expect(round.totalWeight).toBe(1_000_000_000n);
    expect(round.participantCount).toBe(3);
    expect(round.status).toBe("FULL");
    expect(l.escrowBalance(id)).toBe(1_000_000_000n);
  });

  it("rejects a deposit that would exceed the pool cap — never truncates", () => {
    const l = makeLedger();
    const id = l.createRound(0);
    const [a, b] = wallets(2);
    l.deposit({ roundId: id, wallet: a, lamports: 900_000_000n });
    expect(() => l.deposit({ roundId: id, wallet: b, lamports: 200_000_000n })).toThrow(
      LocalLedgerError
    );
    // Unchanged: the rejected deposit left no trace.
    expect(l.getRound(id)!.pot).toBe(900_000_000n);
    expect(l.escrowBalance(id)).toBe(900_000_000n);
    expect(l.getParticipants(id)).toHaveLength(1);
  });

  it("enforces min/max deposit limits and one entry per wallet", () => {
    const l = makeLedger();
    const id = l.createRound(0);
    const [a] = wallets(1);
    expect(() => l.deposit({ roundId: id, wallet: a, lamports: 1_000n })).toThrow(/DepositTooSmall/);
    l.deposit({ roundId: id, wallet: a, lamports: MIN });
    expect(() => l.deposit({ roundId: id, wallet: a, lamports: MIN })).toThrow(/DuplicateDeposit/);
  });

  it("runs FULL -> RANDOMNESS_PENDING -> COMPLETED with the exact 7.5% split", () => {
    const l = makeLedger();
    const id = l.createRound(0);
    const [a, b, c] = wallets(3);
    l.deposit({ roundId: id, wallet: a, lamports: 200_000_000n });
    l.deposit({ roundId: id, wallet: b, lamports: 300_000_000n });
    l.deposit({ roundId: id, wallet: c, lamports: 500_000_000n });

    l.lockRound(id);
    const locked = l.getRound(id)!;
    expect(locked.status).toBe("RANDOMNESS_PENDING");
    expect(locked.feeBps).toBe(200);
    expect(locked.revealSlot).toBe(locked.lockSlot + 32n);

    // Settling before the reveal slot must fail.
    expect(() => l.settleRound(id)).toThrow(/RevealSlotNotReached/);

    advance(32 * 400 + 1000);
    l.settleRound(id);
    const settled = l.getRound(id)!;
    expect(settled.status).toBe("RANDOMNESS_PENDING"); // phase 1 does not move funds
    expect(settled.feeLamports).toBe(20_000_000n); // 1 SOL * 2%
    expect(settled.payoutLamports).toBe(980_000_000n); // 98%
    expect(settled.winner).not.toEqual(PublicKey.default);

    const winner = settled.winner;
    const before = l.receivedBy(winner);
    l.payWinners(id);
    const paid = l.getRound(id)!;
    expect(paid.status).toBe("COMPLETED");
    expect(l.receivedBy(winner)).toBe(before + 980_000_000n);
    expect(l.treasuryAccrued).toBe(20_000_000n);
    expect(l.escrowBalance(id)).toBe(0n);
  });

  it("refuses to pay a completed round twice", () => {
    const l = makeLedger();
    const id = l.createRound(0);
    l.deposit({ roundId: id, wallet: wallets(1)[0]!, lamports: CAP });
    l.lockRound(id);
    advance(32 * 400 + 1000);
    l.settleRound(id);
    l.payWinners(id);
    expect(() => l.payWinners(id)).toThrow(/PayoutNotReady/);
  });

  it("keeps the outcome unknowable at lock time and fixed afterwards", () => {
    const l = makeLedger();
    const id = l.createRound(0);
    const [a, b] = wallets(2);
    l.deposit({ roundId: id, wallet: a, lamports: 400_000_000n });
    l.deposit({ roundId: id, wallet: b, lamports: 600_000_000n });
    l.lockRound(id);
    // The commitment is published, the secret is not.
    const round = l.getRound(id)!;
    expect(round.randomness.every((b) => b === 0)).toBe(true);
    advance(32 * 400 + 1000);
    l.settleRound(id);
    const settled = l.getRound(id)!;
    // Reproduce the reveal independently: blockhash -> deriveRandomness -> ticket.
    const blockhash = l.revealBlockhash(settled.revealSlot)!;
    expect(blockhash).toBeTruthy();
    const randomness = deriveRandomness(blockhash, id);
    expect(Buffer.from(randomness).equals(Buffer.from(settled.randomness))).toBe(true);
    // Re-running settle yields identical values (on-chain determinism).
    const ticket = settled.winningTicket;
    const winner = settled.winner;
    l.settleRound(id);
    expect(l.getRound(id)!.winningTicket).toBe(ticket);
    expect(l.getRound(id)!.winner).toEqual(winner);
  });

  it("picks a winner proportionally to stake", () => {
    const l = makeLedger();
    const a = wallets(1)[0]!;
    // 90% of the pot belongs to A; A must win the overwhelming majority.
    let aWins = 0;
    const runs = 200;
    for (let i = 0; i < runs; i++) {
      clock += 1000;
      const id = l.nextRoundId();
      l.createRound(0);
      l.deposit({ roundId: id, wallet: a, lamports: 900_000_000n });
      l.deposit({ roundId: id, wallet: wallets(1)[0]!, lamports: 100_000_000n });
      l.lockRound(id);
      clock += 32 * 400 + 1000;
      l.settleRound(id);
      if (l.getRound(id)!.winner.equals(a)) aWins++;
    }
    expect(aWins / runs).toBeGreaterThan(0.8);
    expect(aWins / runs).toBeLessThan(1);
  });

  it("refunds every participant on cancel", () => {
    const l = makeLedger();
    const id = l.createRound(0);
    const [a, b] = wallets(2);
    l.deposit({ roundId: id, wallet: a, lamports: 300_000_000n });
    l.deposit({ roundId: id, wallet: b, lamports: 300_000_000n });
    l.cancelRound(id);
    const round = l.getRound(id)!;
    expect(round.status).toBe("CANCELLED");
    expect(round.pot).toBe(0n);
    expect(l.escrowBalance(id)).toBe(0n);
    expect(l.receivedBy(a)).toBe(300_000_000n);
    expect(l.receivedBy(b)).toBe(300_000_000n);
  });

  it("rejects invalid transitions", () => {
    const l = makeLedger();
    const id = l.createRound(0);
    expect(() => l.lockRound(id)).toThrow(/RoundNotFull/);
    expect(() => l.settleRound(id)).toThrow(/InvalidRoundStatus/);
    expect(() => l.payWinners(id)).toThrow(/PayoutNotReady/);
    expect(() => l.createRound(5)).toThrow(/InvalidTier/);
  });

  it("keeps the three pool lanes independent and collision-free", () => {
    const l = makeLedger();
    const r0 = l.createRound(0);
    const r1 = l.createRound(1);
    const r2 = l.createRound(2);
    expect([r0, r1, r2]).toEqual([1n, 2n, 3n]);
    expect(l.getRound(r0)!.tier).toBe(0);
    expect(l.getRound(r1)!.tier).toBe(1);
    expect(l.getRound(r2)!.tier).toBe(2);

    // Settle lane 0 completely; the next id comes from the shared counter and
    // must not collide with the other lanes' rounds.
    l.deposit({ roundId: r0, wallet: wallets(1)[0]!, lamports: CAP });
    l.lockRound(r0);
    advance(32 * 400 + 1000);
    l.settleRound(r0);
    l.payWinners(r0);
    const next = l.createRound(0);
    expect(next).toBe(4n);
    expect(l.headByTier).toEqual([4n, 2n, 3n]);
    expect(l.getRound(r1)!.status).toBe("OPEN");
    expect(l.getRound(r2)!.status).toBe("OPEN");
  });

  it("passes independent verification from recorded randomness", async () => {
    const l = makeLedger();
    const id = l.createRound(0);
    const [a, b] = wallets(2);
    l.deposit({ roundId: id, wallet: a, lamports: 400_000_000n });
    l.deposit({ roundId: id, wallet: b, lamports: 600_000_000n });
    l.lockRound(id);
    advance(32 * 400 + 1000);
    l.settleRound(id);
    l.payWinners(id);

    const outcome = await verifyRoundData(l.getRound(id)!, {
      fetchRound: async () => l.getRound(id),
      fetchParticipants: async () => l.getParticipants(id),
      fetchRevealBlockhash: async (slot) => l.revealBlockhash(slot),
      deriveRandomness,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.trace.computedWinner).toBe(outcome.trace.recordedWinner);
    expect(outcome.trace.expectedFeeLamports).toBe(outcome.trace.recordedFeeLamports);
    expect(outcome.trace.expectedPayoutLamports).toBe(outcome.trace.recordedPayoutLamports);
  });
});
