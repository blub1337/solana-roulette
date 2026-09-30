/**
 * Transaction state machine.
 *
 * The rules pinned here are the money-safety rules: PENDING → CONFIRMED |
 * FAILED, terminal states, one entry per (round, wallet), one signature per
 * transaction, and a pot that only counts CONFIRMED deposits.
 */
import { describe, it, expect } from "vitest";
import { TxLedger, TxStateError, depositKey, payoutKey, nextRetryAt } from "./txLedger.js";

const WALLET = "11111111111111111111111111111112";
const ESCROW = "4Zx2cvqL8xwGV4Y5hcEXysbJCmyiYDRBgBHdidWWvkMp";
const WINNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SIG_A = "a".repeat(64);
const SIG_B = "b".repeat(64);

function deposit(ledger: TxLedger, roundId: string, wallet: string, amount = "1000") {
  return ledger.begin({
    kind: "DEPOSIT",
    idempotencyKey: depositKey(roundId, wallet),
    roundId,
    tier: 0,
    wallet,
    recipient: ESCROW,
    network: "devnet",
    depositAmountLamports: amount,
  });
}

describe("tx lifecycle", () => {
  it("starts PENDING with no signature", () => {
    const ledger = new TxLedger();
    const { tx, created } = deposit(ledger, "1", WALLET);
    expect(created).toBe(true);
    expect(tx.depositStatus).toBe("PENDING");
    expect(tx.depositSignature).toBeNull();
    expect(tx.confirmedAt).toBeNull();
  });

  it("goes PENDING → CONFIRMED and stores the signature", () => {
    const ledger = new TxLedger();
    const { tx } = deposit(ledger, "1", WALLET);
    ledger.attachSignature(tx.id, SIG_A);
    const done = ledger.settle(tx.id, "CONFIRMED", { signature: SIG_A });
    expect(done.depositStatus).toBe("CONFIRMED");
    expect(done.depositSignature).toBe(SIG_A);
    expect(done.confirmedAt).toBeInstanceOf(Date);
  });

  it("goes PENDING → FAILED with a reason", () => {
    const ledger = new TxLedger();
    const { tx } = deposit(ledger, "1", WALLET);
    const failed = ledger.settle(tx.id, "FAILED", { error: "rejected by player" });
    expect(failed.depositStatus).toBe("FAILED");
    expect(failed.lastError).toBe("rejected by player");
    expect(failed.nextRetryAt).toBeInstanceOf(Date);
  });

  it("never revives a FAILED transaction", () => {
    const ledger = new TxLedger();
    const { tx } = deposit(ledger, "1", WALLET);
    ledger.settle(tx.id, "FAILED", { error: "boom" });
    expect(() => ledger.settle(tx.id, "CONFIRMED", { signature: SIG_A })).toThrow(TxStateError);
  });

  it("never un-confirms a CONFIRMED transaction", () => {
    const ledger = new TxLedger();
    const { tx } = deposit(ledger, "1", WALLET);
    ledger.settle(tx.id, "CONFIRMED", { signature: SIG_A });
    expect(() => ledger.settle(tx.id, "FAILED", { error: "late" })).toThrow(TxStateError);
  });

  it("is idempotent when the same confirmation arrives twice", () => {
    const ledger = new TxLedger();
    const { tx } = deposit(ledger, "1", WALLET);
    ledger.settle(tx.id, "CONFIRMED", { signature: SIG_A });
    const again = ledger.settle(tx.id, "CONFIRMED", { signature: SIG_A });
    expect(again.depositStatus).toBe("CONFIRMED");
    expect(again.attempts).toBe(1);
  });
});

describe("idempotency keys", () => {
  it("returns the SAME record for a repeated deposit intent (refresh-safe)", () => {
    const ledger = new TxLedger();
    const first = deposit(ledger, "1", WALLET);
    const second = deposit(ledger, "1", WALLET, "999999");
    expect(second.created).toBe(false);
    expect(second.tx.id).toBe(first.tx.id);
    // The original amount wins: a replay cannot change what was agreed.
    expect(second.tx.depositAmountLamports).toBe("1000");
  });

  it("allows one entry per wallet but a different wallet gets its own record", () => {
    const ledger = new TxLedger();
    const a = deposit(ledger, "1", WALLET);
    const b = deposit(ledger, "1", WINNER);
    expect(b.created).toBe(true);
    expect(b.tx.id).not.toBe(a.tx.id);
  });

  it("rejects a signature that is already bound to another transaction", () => {
    const ledger = new TxLedger();
    const a = deposit(ledger, "1", WALLET).tx;
    const b = deposit(ledger, "1", WINNER).tx;
    ledger.attachSignature(a.id, SIG_A);
    expect(() => ledger.attachSignature(b.id, SIG_A)).toThrow(/signature_reused|already recorded/);
  });

  it("refuses to overwrite the signature of a submitted transaction", () => {
    const ledger = new TxLedger();
    const { tx } = deposit(ledger, "1", WALLET);
    ledger.attachSignature(tx.id, SIG_A);
    expect(() => ledger.attachSignature(tx.id, SIG_B)).toThrow(TxStateError);
  });
});

describe("pot accounting", () => {
  it("counts only CONFIRMED deposits", () => {
    const ledger = new TxLedger();
    const a = deposit(ledger, "7", WALLET, "1000").tx;
    const b = deposit(ledger, "7", WINNER, "2000").tx;
    const c = deposit(ledger, "7", "11111111111111111111111111111113", "4000").tx;
    expect(ledger.confirmedPotLamports("7")).toBe(0n);

    ledger.settle(a.id, "CONFIRMED", { signature: SIG_A });
    expect(ledger.confirmedPotLamports("7")).toBe(1000n);

    ledger.settle(b.id, "FAILED", { error: "rejected" });
    ledger.settle(c.id, "CONFIRMED", { signature: SIG_B });
    expect(ledger.confirmedPotLamports("7")).toBe(5000n);
  });

  it("is per round", () => {
    const ledger = new TxLedger();
    const a = deposit(ledger, "1", WALLET, "1000").tx;
    ledger.settle(a.id, "CONFIRMED", { signature: SIG_A });
    expect(ledger.confirmedPotLamports("1")).toBe(1000n);
    expect(ledger.confirmedPotLamports("2")).toBe(0n);
  });
});

describe("payout records", () => {
  it("gives one record per attempt and finds the latest", () => {
    const ledger = new TxLedger();
    const first = ledger.begin({
      kind: "PAYOUT",
      idempotencyKey: payoutKey("5", 1),
      roundId: "5",
      tier: 0,
      wallet: WINNER,
      recipient: WINNER,
      network: "devnet",
      payoutAmountLamports: "925",
      feeLamports: "75",
    });
    ledger.settle(first.tx.id, "FAILED", { error: "escrow short" });
    const second = ledger.begin({
      kind: "PAYOUT",
      idempotencyKey: payoutKey("5", 2),
      roundId: "5",
      tier: 0,
      wallet: WINNER,
      recipient: WINNER,
      network: "devnet",
      payoutAmountLamports: "925",
      feeLamports: "75",
    });
    expect(second.created).toBe(true);
    expect(ledger.latestPayout("5")?.id).toBe(second.tx.id);
    expect(ledger.getConfirmedPayout("5")).toBeNull();
  });

  it("reports a CONFIRMED payout as the duplicate-payment guard", () => {
    const ledger = new TxLedger();
    const { tx } = ledger.begin({
      kind: "PAYOUT",
      idempotencyKey: payoutKey("5", 1),
      roundId: "5",
      tier: 0,
      wallet: WINNER,
      recipient: WINNER,
      network: "devnet",
      payoutAmountLamports: "925",
      feeLamports: "75",
    });
    ledger.settle(tx.id, "CONFIRMED", { signature: SIG_A });
    expect(ledger.getConfirmedPayout("5")?.depositSignature).toBe(SIG_A);
  });
});

describe("backoff + queues", () => {
  it("backs off 15s, 30s, 60s and caps at 5 minutes", () => {
    const first = nextRetryAt(1).getTime() - Date.now();
    const second = nextRetryAt(2).getTime() - Date.now();
    const capped = nextRetryAt(20).getTime() - Date.now();
    expect(first).toBeGreaterThan(14_000);
    expect(second).toBeGreaterThan(first);
    expect(capped).toBeLessThanOrEqual(300_000);
  });

  it("lists only PENDING deposits older than the cutoff", () => {
    const ledger = new TxLedger();
    const a = deposit(ledger, "1", WALLET).tx;
    const b = deposit(ledger, "1", WINNER).tx;
    ledger.settle(b.id, "CONFIRMED", { signature: SIG_B });
    expect(ledger.listStalePending(0).map((t) => t.id)).toEqual([a.id]);
  });
});

/**
 * Restart safety.
 *
 * The ledger is in memory and the audit mirror is write-through, so the guards
 * only survive a restart if the mirror is read back. Without that, a fresh
 * process has no memory of which deposits are CONFIRMED, which signatures are
 * spent and which rounds are already paid — exactly the state in which the same
 * on-chain transfer can be handed to the API a second time.
 */
describe("restore from the audit mirror", () => {
  /** The shape a mirror row comes back in. */
  function mirrored(
    over: Partial<Parameters<TxLedger["restore"]>[0][number]> = {}
  ): Parameters<TxLedger["restore"]>[0][number] {
    const now = new Date();
    return {
      id: "restored-1",
      idempotencyKey: depositKey("1", WALLET),
      kind: "DEPOSIT",
      roundId: "1",
      tier: 0,
      wallet: WALLET,
      recipient: ESCROW,
      network: "devnet",
      depositAmountLamports: "1000",
      depositSignature: SIG_A,
      depositStatus: "CONFIRMED",
      payoutAmountLamports: null,
      payoutSignature: null,
      payoutStatus: null,
      feeLamports: null,
      attempts: 1,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      confirmedAt: now,
      nextRetryAt: null,
      ...over,
    };
  }

  it("brings back the confirmed-deposit gate, the spent signature and the paid-round guard", () => {
    const ledger = new TxLedger();
    const restored = ledger.restore([
      mirrored(),
      mirrored({
        id: "restored-2",
        idempotencyKey: payoutKey("1", 1),
        kind: "PAYOUT",
        wallet: WINNER,
        recipient: WINNER,
        depositAmountLamports: null,
        depositSignature: SIG_B,
        depositStatus: null,
        payoutAmountLamports: "980",
        payoutSignature: SIG_B,
        payoutStatus: "CONFIRMED",
        feeLamports: "20",
      }),
    ]);
    expect(restored).toBe(2);

    // The wallet is already in the round — a restart must not forget that.
    expect(ledger.getConfirmedDeposit("1", WALLET)?.depositSignature).toBe(SIG_A);
    expect(ledger.confirmedPotLamports("1")).toBe(1000n);
    // The round is already paid.
    expect(ledger.getConfirmedPayout("1")?.depositSignature).toBe(SIG_B);
    // A repeat intent resumes the restored record instead of opening a new one.
    expect(ledger.begin({ ...depositInput("1", WALLET) }).created).toBe(false);
  });

  it("refuses to re-bind a signature that a live record already owns", () => {
    const ledger = new TxLedger();
    const live = deposit(ledger, "1", WALLET).tx;
    ledger.settle(live.id, "CONFIRMED", { signature: SIG_A });

    // A stale mirror row claiming the same signature for another record must
    // not steal the binding from the record that is live right now.
    const restored = ledger.restore([mirrored({ id: "ghost", idempotencyKey: depositKey("9", WINNER), wallet: WINNER })]);
    expect(restored).toBe(0);
    expect(ledger.bySignature(SIG_A)?.id).toBe(live.id);
  });

  it("never overwrites a record that is already in memory", () => {
    const ledger = new TxLedger();
    const live = deposit(ledger, "1", WALLET).tx;
    const restored = ledger.restore([mirrored({ id: live.id, depositStatus: "PENDING", depositSignature: null })]);
    expect(restored).toBe(0);
    expect(ledger.get(live.id)?.depositStatus).toBe("PENDING");
  });

  it("ignores rows without an id or a key", () => {
    const ledger = new TxLedger();
    expect(ledger.restore([mirrored({ id: "" }), mirrored({ id: "x", idempotencyKey: "" })])).toBe(0);
    expect(ledger.listRecent()).toHaveLength(0);
  });
});

/**
 * A cancel or the expiry reaper can mark a deposit FAILED while a confirmation
 * is still reading the chain. If the transfer then turns out to be real, the
 * record has to say CONFIRMED: the pot contains the lamports and the payout is
 * computed from CONFIRMED deposits only, so a FAILED row would pay the winner
 * short and leave the difference unexplained in the escrow.
 */
describe("confirm a deposit that was failed while in flight", () => {
  it("moves FAILED → CONFIRMED and puts the deposit back into the pot", () => {
    const ledger = new TxLedger();
    const { tx } = deposit(ledger, "1", WALLET, "1000");
    ledger.failPending(tx.id, "rejected: the player closed the wallet");

    const revived = ledger.confirmProvenArrival(tx.id, { signature: SIG_A });
    expect(revived.depositStatus).toBe("CONFIRMED");
    expect(revived.depositSignature).toBe(SIG_A);
    expect(revived.lastError).toBeNull();
    expect(ledger.confirmedPotLamports("1")).toBe(1000n);
    expect(ledger.getConfirmedDeposit("1", WALLET)?.id).toBe(tx.id);
  });

  it("is a no-op when the record is already CONFIRMED, and never changes the signature", () => {
    const ledger = new TxLedger();
    const { tx } = deposit(ledger, "1", WALLET);
    ledger.settle(tx.id, "CONFIRMED", { signature: SIG_A });
    expect(ledger.confirmProvenArrival(tx.id, { signature: SIG_A }).depositStatus).toBe("CONFIRMED");
    expect(() => ledger.confirmProvenArrival(tx.id, { signature: SIG_B })).toThrow(/signature_conflict|already confirmed/);
    expect(ledger.get(tx.id)?.depositSignature).toBe(SIG_A);
  });

  it("refuses to steal a signature that another record already owns", () => {
    const ledger = new TxLedger();
    const first = deposit(ledger, "1", WALLET).tx;
    ledger.settle(first.id, "CONFIRMED", { signature: SIG_A });
    const other = deposit(ledger, "1", WINNER).tx;
    ledger.failPending(other.id, "rejected");

    expect(() => ledger.confirmProvenArrival(other.id, { signature: SIG_A })).toThrow(/already recorded/);
    expect(ledger.get(other.id)?.depositStatus).toBe("FAILED");
  });
});

function depositInput(roundId: string, wallet: string) {
  return {
    kind: "DEPOSIT" as const,
    idempotencyKey: depositKey(roundId, wallet),
    roundId,
    tier: 0,
    wallet,
    recipient: ESCROW,
    network: "devnet",
    depositAmountLamports: "1000",
  };
}
