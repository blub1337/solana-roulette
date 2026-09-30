/**
 * Independent verification pipeline — the fairness guarantee tests.
 *
 * verifyRoundData is what a third party runs to check a draw
 * (`GET /api/round/:id/verify`). These tests pin the two properties that make
 * it a real audit and not a rubber stamp:
 *
 *  1. a correctly settled round verifies with every check green;
 *  2. ANY inconsistency between the recorded outcome and the recomputation —
 *     fee, payout, ticket, winner, or a broken weight chain — fails `ok`.
 *
 * The zero-amount leniency (`recorded === 0n` accepted) is scoped to rounds
 * whose winner is NOT yet frozen: settle phase 1 writes fee and payout in the
 * same instruction as the winner, so a frozen winner with a zero fee on a
 * non-zero pot is an inconsistency, never a pending state.
 */
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { verifyRoundData, type VerifyDeps } from "./verifyRound.js";
import { deriveRandomness } from "./winner.js";
import { computeFeeSplit, computeTicket, selectWinner, type WeightedEntry } from "./winnerCore.js";
import type { ParticipantData, RoundData } from "./accounts.js";

const ROUND_ID = 42n;
const POT = 1_000_000_000n; // 1 SOL
const FEE_BPS = 200; // fee_bps frozen into the round at lock
const WALLET_A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const WALLET_B = "4Zx2cvqL8xwGV4Y5hcEXysbJCmyiYDRBgBHdidWWvkMp";
const IMPOSTOR = new PublicKey("11111111111111111111111111111112");

/** Deterministic non-zero entropy input (what settle_round persists). */
const REVEAL_INPUT = new Uint8Array(32).fill(0xab);

function participants(amounts: [bigint, bigint] = [400_000_000n, 600_000_000n]): ParticipantData[] {
  const round = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
  let start = 0n;
  return [
    { wallet: new PublicKey(WALLET_A), amount: amounts[0], weightStart: start, index: 0, bump: 255, round },
    {
      wallet: new PublicKey(WALLET_B),
      amount: amounts[1],
      weightStart: (start += amounts[0]),
      index: 1,
      bump: 254,
      round,
    },
  ].map((p) => ({ ...p, weightStart: p.weightStart }));
}

function entriesOf(ps: ParticipantData[]): WeightedEntry[] {
  return ps.map((p) => ({ id: p.wallet.toBase58(), amount: p.amount, weightStart: p.weightStart, index: p.index }));
}

/** The outcome the program would have frozen for these inputs. */
function correctOutcome(ps: ParticipantData[]) {
  const randomness = deriveRandomness(REVEAL_INPUT, ROUND_ID);
  const ticket = computeTicket(randomness, POT);
  const winnerId = selectWinner(entriesOf(ps), ticket).id;
  const { fee, payout } = computeFeeSplit(POT, FEE_BPS);
  return { randomness, ticket, winner: new PublicKey(winnerId), fee, payout };
}

function makeRound(ps: ParticipantData[], overrides: Partial<RoundData> = {}): RoundData {
  const o = correctOutcome(ps);
  return {
    id: ROUND_ID,
    status: "COMPLETED",
    escrow: new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => 32 - i)),
    pot: POT,
    totalWeight: POT,
    participantCount: ps.length,
    lockSlot: 1_000n,
    revealSlot: 1_032n,
    feeBps: FEE_BPS,
    randomness: o.randomness,
    winningTicket: o.ticket,
    winner: o.winner,
    feeLamports: o.fee,
    payoutLamports: o.payout,
    payoutAccount: new Uint8Array(o.winner.toBytes()),
    tier: 0,
    bump: 250,
    revealInput: REVEAL_INPUT,
    ...overrides,
  };
}

function deps(ps: ParticipantData[]): VerifyDeps {
  return {
    fetchRound: async () => null,
    fetchParticipants: async () => ps,
    fetchRevealBlockhash: async () => null,
    deriveRandomness,
  };
}

const check = (t: Awaited<ReturnType<typeof verifyRoundData>>, name: string) =>
  t.trace.checks.find((c) => c.name === name);

describe("verifyRoundData — fair round", () => {
  it("blesses a correctly settled round with every check green", async () => {
    const ps = participants();
    const outcome = await verifyRoundData(makeRound(ps), deps(ps));
    expect(outcome.ok).toBe(true);
    expect(outcome.trace.entropySource).toBe("persisted_input");
    expect(outcome.trace.computedWinner).toBe(outcome.trace.recordedWinner);
    for (const c of outcome.trace.checks) expect(c.pass, c.name).toBe(true);
  });

  it("still verifies a zero-fee round while the winner is NOT frozen (leniency stays pre-freeze)", async () => {
    const ps = participants();
    const o = correctOutcome(ps);
    const pending = makeRound(ps, {
      status: "RANDOMNESS_PENDING",
      winner: undefined as unknown as PublicKey,
      payoutAccount: new Uint8Array(32),
      feeLamports: 0n,
      payoutLamports: 0n,
      winningTicket: o.ticket,
    });
    const outcome = await verifyRoundData(pending, deps(ps));
    expect(outcome.ok).toBe(true);
    expect(check(outcome, "fee_matches_pot_x_fee_bps")!.pass).toBe(true);
    expect(check(outcome, "payout_matches_pot_minus_fee")!.pass).toBe(true);
  });
});

describe("verifyRoundData — tampered outcomes must fail", () => {
  it("rejects a fee that does not match pot × fee_bps once the winner is frozen", async () => {
    const ps = participants();
    // The regression: fee_lamports = 0 used to pass because of the blanket
    // `|| recorded === 0n` leniency, even with a frozen winner on a 1-SOL pot.
    const outcome = await verifyRoundData(makeRound(ps, { feeLamports: 0n }), deps(ps));
    expect(outcome.ok).toBe(false);
    expect(check(outcome, "fee_matches_pot_x_fee_bps")!.pass).toBe(false);
  });

  it("rejects a payout that breaks fee + payout = pot", async () => {
    const ps = participants();
    const { fee, payout } = computeFeeSplit(POT, FEE_BPS);
    const outcome = await verifyRoundData(
      makeRound(ps, { payoutLamports: payout + 1n, feeLamports: fee - 1n }),
      deps(ps)
    );
    expect(outcome.ok).toBe(false);
    expect(check(outcome, "payout_matches_pot_minus_fee")!.pass).toBe(false);
  });

  it("rejects a recorded winning ticket that is not the recomputed one", async () => {
    const ps = participants();
    const { ticket } = correctOutcome(ps);
    const outcome = await verifyRoundData(makeRound(ps, { winningTicket: ticket + 1n }), deps(ps));
    expect(outcome.ok).toBe(false);
    expect(check(outcome, "ticket_matches_recorded")!.pass).toBe(false);
  });

  it("rejects a recorded winner that is not the recomputed one", async () => {
    const ps = participants();
    const outcome = await verifyRoundData(makeRound(ps, { winner: IMPOSTOR }), deps(ps));
    expect(outcome.ok).toBe(false);
    expect(check(outcome, "recorded_winner_matches_recomputation")!.pass).toBe(false);
  });

  it("rejects a payout_account that differs from the recorded winner", async () => {
    const ps = participants();
    const o = correctOutcome(ps);
    // Winner agrees with the recomputation, but the account frozen to receive
    // the payout does not — the verifier must flag the inconsistency.
    const outcome = await verifyRoundData(
      makeRound(ps, { winner: o.winner, payoutAccount: new Uint8Array(IMPOSTOR.toBytes()) }),
      deps(ps)
    );
    expect(outcome.ok).toBe(false);
    expect(check(outcome, "payout_account_matches_recomputed_winner")!.pass).toBe(false);
  });

  it("rejects a broken weight chain (weights no longer sum to the pot)", async () => {
    const ps = participants();
    // Tamper: participant B's recorded weight is 10 lamports higher than its
    // deposit — the cumulative chain no longer matches the entries.
    const tampered = ps.map((p, i) => (i === 1 ? { ...p, amount: p.amount + 10n } : p));
    const sum = tampered.reduce((a, p) => a + p.amount, 0n);
    const round = makeRound(tampered, { totalWeight: sum });
    const outcome = await verifyRoundData(round, deps(tampered));
    expect(outcome.ok).toBe(false);
    expect(check(outcome, "weight_chain_sums_to_pot")!.pass).toBe(false);
  });

  it("rejects a settled round with no persisted entropy input (not independently recomputable)", async () => {
    const ps = participants();
    // Pre-redeploy fallback: randomness recorded but no reveal_input — the
    // draw cannot be recomputed by a third party, so it must not verify.
    const outcome = await verifyRoundData(
      makeRound(ps, { revealInput: new Uint8Array(32) }),
      deps(ps)
    );
    expect(outcome.ok).toBe(false);
    expect(
      check(outcome, "entropy_recomputed_from_persisted_input_matches_recorded")!.pass
    ).toBe(false);
  });
});
