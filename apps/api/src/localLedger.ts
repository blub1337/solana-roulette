/**
 * Local devnet ledger — an in-process runtime that mirrors
 * `programs/roulette` instruction-for-instruction.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Anchor program is the production path and the only path that ever moves
 * real SOL. It cannot be deployed from this sandbox (no Rust toolchain), so
 * without a local runtime the platform has no rounds, no deposits and no
 * settlement at all. This ledger reproduces the program's semantics exactly —
 * same state machine, same PDA seeds, same cumulative-weight walk, same
 * integer-lamport fee split, same `SHA256(tag ‖ round_id_le ‖ blockhash)`
 * entropy — so the whole product runs end to end on devnet while the program
 * remains the single source of truth the moment it is deployed
 * (see `resolveBackend`, which switches to the chain automatically).
 *
 * WHAT IT IS NOT
 * --------------
 * It is NOT money. No lamports move, no pool wallet exists, no private key is
 * held. `LocalLedgerError` mirrors the program's `RouletteError` names so both
 * paths fail identically. It refuses to run on mainnet (hard gate).
 *
 * RANDOMNESS
 * ----------
 * The program reads a future blockhash from the SlotHashes sysvar. Here a
 * virtual slot clock plays that role, and entropy comes from a real
 * commit–reveal: `lock_round` commits `sha256(tag ‖ round_id_le ‖ secret)`
 * and keeps the secret private; it is only revealed once the reveal slot is
 * reached, so the outcome is genuinely unknowable at lock time. The revealed
 * blockhash is then fed through the SAME `deriveRandomness` as the program.
 * Trust assumptions: docs/RANDOMNESS.md.
 */
import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import {
  computeFeeSplit,
  computeTicket,
  selectWinner,
  deriveRandomness,
  getEscrowPda,
  getRoundPda,
  getParticipantPda,
  type GlobalConfigData,
  type ParticipantData,
  type RoundData,
} from "@solana-roulette/verification";
import { TIER_COUNT, type RoundState } from "@solana-roulette/types";

/** Mirrors `RouletteError` in programs/roulette/src/errors.rs. */
export type LocalErrorCode =
  | "InvalidFeeBps"
  | "InvalidDepositLimits"
  | "InvalidOperator"
  | "InvalidRoundStatus"
  | "RoundOverCap"
  | "DepositTooSmall"
  | "DepositTooLarge"
  | "RoundNotFull"
  | "RevealSlotNotReached"
  | "ArithmeticOverflow"
  | "InvalidParticipant"
  | "NothingToRefund"
  | "DuplicateDeposit"
  | "PayoutNotReady"
  | "InvalidWinnerAccount"
  | "InvalidTreasury"
  | "InvalidTier";

export class LocalLedgerError extends Error {
  constructor(readonly code: LocalErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "LocalLedgerError";
  }
}

export interface LocalLedgerConfig {
  programId: PublicKey;
  /** Operator identity. In local mode there is no signer; this is bookkeeping. */
  operator: PublicKey;
  /** Platform fee wallet — receives 7.5% ONLY, never deposits. */
  treasury: PublicKey;
  feeBps: number;
  tierCaps: [bigint, bigint, bigint];
  minDeposit: bigint;
  maxDeposit: bigint;
  maxRoundSize: bigint;
  revealOffsetSlots: bigint;
  /** Virtual slot duration in ms (devnet-like ~400ms). */
  slotMs?: number;
  /** Injectable clock/randomness for deterministic tests. */
  now?: () => number;
  random?: (n: number) => Uint8Array;
}

interface LocalParticipant {
  round: PublicKey;
  wallet: PublicKey;
  amount: bigint;
  weightStart: bigint;
  index: number;
  bump: number;
}

interface LocalRound {
  id: bigint;
  status: RoundState;
  escrow: PublicKey;
  pot: bigint;
  totalWeight: bigint;
  participantCount: number;
  lockSlot: bigint;
  revealSlot: bigint;
  feeBps: number;
  randomness: Uint8Array;
  winningTicket: bigint;
  winner: PublicKey;
  feeLamports: bigint;
  payoutLamports: bigint;
  payoutAccount: Uint8Array;
  tier: number;
  bump: number;
  /** The revealed "blockhash" fed to deriveRandomness (mirrors Round.reveal_input). */
  revealInput: Uint8Array;
  participants: LocalParticipant[];
  escrowBalance: bigint;
  /** Commit–reveal: public commitment + privately held secret. */
  commit: Uint8Array;
  secret: Uint8Array | null;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Minimal base58 encoder (no dependency on the ESM-only bs58 build). */
function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58[digits[i]!];
  return out;
}

function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

function sha256(...parts: Buffer[]): Uint8Array {
  return new Uint8Array(createHash("sha256").update(Buffer.concat(parts)).digest());
}

export class LocalLedger {
  readonly mode = "local" as const;

  private readonly rounds = new Map<string, LocalRound>();
  private readonly slotHashes = new Map<string, Uint8Array>();
  private readonly cfg: Required<LocalLedgerConfig>;
  private readonly startedAt: number;
  private roundCounter = 0n;
  /** Head round per pool lane (0=1 SOL, 1=10 SOL, 2=100 SOL). */
  readonly headByTier: bigint[] = Array.from({ length: TIER_COUNT }, () => 0n);
  /** Treasury accrual, in lamports — proves the 7.5% split end to end. */
  treasuryAccrued = 0n;
  /**
   * Lamports each wallet has RECEIVED from rounds (payouts and refunds).
   * Deliberately not a full wallet model: the round escrow is the only account
   * that holds money here, and a deposit does not credit the depositor.
   */
  readonly receivedByWallet = new Map<string, bigint>();

  constructor(config: LocalLedgerConfig) {
    this.cfg = {
      slotMs: 400,
      now: () => Date.now(),
      random: (n: number) => new Uint8Array(nodeRandomBytes(n)),
      ...config,
    } as Required<LocalLedgerConfig>;
    if (this.cfg.feeBps > 3000) {
      throw new LocalLedgerError("InvalidFeeBps", `fee_bps=${this.cfg.feeBps} > 3000`);
    }
    if (
      this.cfg.minDeposit <= 0n ||
      this.cfg.minDeposit > this.cfg.maxDeposit ||
      this.cfg.maxDeposit > this.cfg.maxRoundSize
    ) {
      throw new LocalLedgerError("InvalidDepositLimits");
    }
    this.startedAt = this.cfg.now();
  }

  // ------------------------------------------------------------------
  // clock
  // ------------------------------------------------------------------

  /** Virtual slot (devnet-like cadence, monotonic within a process). */
  currentSlot(): bigint {
    const elapsed = this.cfg.now() - this.startedAt;
    return 250_000_000n + BigInt(Math.max(0, Math.floor(elapsed / this.cfg.slotMs)));
  }

  revealBlockhash(slot: bigint): Uint8Array | null {
    return this.slotHashes.get(slot.toString()) ?? null;
  }

  // ------------------------------------------------------------------
  // reads (same shapes the RPC decoders produce)
  // ------------------------------------------------------------------

  globalConfig(): GlobalConfigData {
    return {
      operator: this.cfg.operator,
      treasury: this.cfg.treasury,
      feeBps: this.cfg.feeBps,
      maxRoundSize: this.cfg.maxRoundSize,
      minDeposit: this.cfg.minDeposit,
      maxDeposit: this.cfg.maxDeposit,
      revealOffset: this.cfg.revealOffsetSlots,
      roundCounter: this.roundCounter,
      tierCaps: this.cfg.tierCaps,
      bump: 0,
    };
  }

  getRound(roundId: bigint): RoundData | null {
    const r = this.rounds.get(roundId.toString());
    if (!r) return null;
    return {
      id: r.id,
      status: r.status,
      escrow: r.escrow,
      pot: r.pot,
      totalWeight: r.totalWeight,
      participantCount: r.participantCount,
      lockSlot: r.lockSlot,
      revealSlot: r.revealSlot,
      feeBps: r.feeBps,
      randomness: r.randomness,
      winningTicket: r.winningTicket,
      winner: r.winner,
      feeLamports: r.feeLamports,
      payoutLamports: r.payoutLamports,
      payoutAccount: r.payoutAccount,
      tier: r.tier,
      bump: r.bump,
      revealInput: r.revealInput,
    };
  }

  getParticipants(roundId: bigint): ParticipantData[] {
    const r = this.rounds.get(roundId.toString());
    if (!r) return [];
    return r.participants.map((p) => ({ ...p }));
  }

  escrowBalance(roundId: bigint): bigint {
    return this.rounds.get(roundId.toString())?.escrowBalance ?? 0n;
  }

  /** Lamports this wallet has received from the platform. */
  receivedBy(wallet: PublicKey): bigint {
    return this.receivedByWallet.get(wallet.toBase58()) ?? 0n;
  }

  /** Next round id = shared counter + 1 (matches the program's rule). */
  nextRoundId(): bigint {
    return this.roundCounter + 1n;
  }

  private require(roundId: bigint): LocalRound {
    const r = this.rounds.get(roundId.toString());
    if (!r) throw new LocalLedgerError("InvalidRoundStatus", `round ${roundId} does not exist`);
    return r;
  }

  // ------------------------------------------------------------------
  // create_round
  // ------------------------------------------------------------------

  createRound(tier: number): bigint {
    if (!Number.isInteger(tier) || tier < 0 || tier >= TIER_COUNT) {
      throw new LocalLedgerError("InvalidTier", `tier=${tier}`);
    }
    const roundId = this.nextRoundId();
    const [roundPk, roundBump] = getRoundPda(this.cfg.programId, roundId);
    const [escrowPk] = getEscrowPda(this.cfg.programId, roundId);
    this.rounds.set(roundId.toString(), {
      id: roundId,
      status: "OPEN",
      escrow: escrowPk,
      pot: 0n,
      totalWeight: 0n,
      participantCount: 0,
      lockSlot: 0n,
      revealSlot: 0n,
      feeBps: this.cfg.feeBps,
      randomness: new Uint8Array(32),
      winningTicket: 0n,
      winner: PublicKey.default,
      feeLamports: 0n,
      payoutLamports: 0n,
      payoutAccount: new Uint8Array(32),
      tier,
      bump: roundBump,
      revealInput: new Uint8Array(32),
      participants: [],
      escrowBalance: 0n,
      // Placeholder commitment; replaced by lock_round.
      commit: sha256(Buffer.from("roulette:local-uncommitted", "utf8"), u64le(roundId), roundPk.toBuffer()),
      secret: null,
    });
    this.roundCounter = roundId;
    this.headByTier[tier] = roundId;
    return roundId;
  }

  // ------------------------------------------------------------------
  // deposit
  // ------------------------------------------------------------------

  deposit(args: { roundId: bigint; wallet: PublicKey; lamports: bigint }): void {
    const r = this.require(args.roundId);
    if (r.status !== "OPEN") {
      throw new LocalLedgerError("InvalidRoundStatus", `status=${r.status}`);
    }
    if (args.lamports < this.cfg.minDeposit) {
      throw new LocalLedgerError("DepositTooSmall", `${args.lamports} < ${this.cfg.minDeposit}`);
    }
    if (args.lamports > this.cfg.maxDeposit) {
      throw new LocalLedgerError("DepositTooLarge", `${args.lamports} > ${this.cfg.maxDeposit}`);
    }
    const newPot = r.pot + args.lamports;
    const tierCap = this.cfg.tierCaps[r.tier];
    if (tierCap === undefined) throw new LocalLedgerError("InvalidTier", `tier=${r.tier}`);
    if (newPot > tierCap) {
      throw new LocalLedgerError(
        "RoundOverCap",
        `pot would be ${newPot} > tier cap ${tierCap} (rejected, never truncated)`
      );
    }
    if (newPot > this.cfg.maxRoundSize) {
      throw new LocalLedgerError("RoundOverCap", `pot would be ${newPot} > max round size`);
    }
    if (r.participants.some((p) => p.wallet.equals(args.wallet))) {
      throw new LocalLedgerError("DuplicateDeposit", "wallet already has an entry");
    }

    const [roundPk] = getRoundPda(this.cfg.programId, r.id);
    const [, bump] = getParticipantPda(this.cfg.programId, roundPk, args.wallet);

    r.participants.push({
      round: roundPk,
      wallet: args.wallet,
      amount: args.lamports,
      weightStart: r.totalWeight,
      index: r.participantCount,
      bump,
    });
    r.pot = newPot;
    r.totalWeight += args.lamports;
    r.participantCount += 1;
    r.escrowBalance += args.lamports;

    // Auto-close exactly at the pool limit (the frontend never decides this).
    if (r.pot === tierCap) r.status = "FULL";
  }

  private credit(wallet: PublicKey, lamports: bigint): void {
    const k = wallet.toBase58();
    this.receivedByWallet.set(k, (this.receivedByWallet.get(k) ?? 0n) + lamports);
  }

  // ------------------------------------------------------------------
  // lock_round
  // ------------------------------------------------------------------

  lockRound(roundId: bigint): void {
    const r = this.require(roundId);
    if (r.status !== "FULL") {
      throw new LocalLedgerError("RoundNotFull", `status=${r.status}`);
    }
    const slot = this.currentSlot();
    r.lockSlot = slot;
    r.revealSlot = slot + this.cfg.revealOffsetSlots;
    r.feeBps = this.cfg.feeBps; // fee snapshot frozen at lock
    // Commit–reveal: publish the commitment, keep the secret private.
    const secret = this.cfg.random(32);
    r.secret = secret;
    r.commit = sha256(Buffer.from("roulette:local-commit", "utf8"), u64le(r.id), Buffer.from(secret));
    r.status = "RANDOMNESS_PENDING";
  }

  // ------------------------------------------------------------------
  // settle_round (phase 1 — freezes the outcome, moves no lamports)
  // ------------------------------------------------------------------

  settleRound(roundId: bigint): void {
    const r = this.require(roundId);
    if (r.status !== "RANDOMNESS_PENDING") {
      throw new LocalLedgerError("InvalidRoundStatus", `status=${r.status}`);
    }
    if (this.currentSlot() < r.revealSlot) {
      throw new LocalLedgerError("RevealSlotNotReached", `slot < ${r.revealSlot}`);
    }
    if (!r.secret) {
      throw new LocalLedgerError("InvalidRoundStatus", "no committed randomness on this round");
    }

    // Reveal: the "blockhash" produced at the committed reveal slot.
    const blockhash = sha256(
      Buffer.from("roulette:local-slot", "utf8"),
      u64le(r.id),
      Buffer.from(r.secret)
    );
    this.slotHashes.set(r.revealSlot.toString(), blockhash);
    // Persist the input exactly like the program does, so verifyRoundData can
    // recompute the draw from the round record alone.
    r.revealInput = blockhash;

    // Identical derivation to the program.
    const randomness = deriveRandomness(blockhash, r.id);
    const ticket = computeTicket(randomness, r.totalWeight);
    const entries = r.participants.map((p) => ({
      id: p.wallet.toBase58(),
      amount: p.amount,
      weightStart: p.weightStart,
      index: p.index,
    }));
    const { id } = selectWinner(entries, ticket);
    const winner = r.participants.find((p) => p.wallet.toBase58() === id);
    if (!winner) throw new LocalLedgerError("InvalidParticipant", `winner ${id} not found`);

    const { fee, payout } = computeFeeSplit(r.pot, r.feeBps);

    r.randomness = randomness;
    r.winningTicket = ticket;
    r.winner = winner.wallet;
    r.payoutAccount = new Uint8Array(winner.wallet.toBytes());
    r.feeLamports = fee;
    r.payoutLamports = payout;
    // Status stays RANDOMNESS_PENDING: pay_winners is phase 2.
  }

  // ------------------------------------------------------------------
  // pay_winners (phase 2 — atomic payout, then terminal COMPLETED)
  // ------------------------------------------------------------------

  payWinners(roundId: bigint): void {
    const r = this.require(roundId);
    if (r.status !== "RANDOMNESS_PENDING") {
      throw new LocalLedgerError("PayoutNotReady", `status=${r.status}`);
    }
    if (r.winner.equals(PublicKey.default)) {
      throw new LocalLedgerError("InvalidWinnerAccount", "winner not frozen");
    }
    const payoutAccount = new PublicKey(r.payoutAccount);
    if (!payoutAccount.equals(r.winner)) {
      throw new LocalLedgerError("InvalidWinnerAccount");
    }
    if (this.cfg.treasury.equals(PublicKey.default)) {
      throw new LocalLedgerError("InvalidTreasury");
    }
    const total = r.payoutLamports + r.feeLamports;
    if (r.escrowBalance < total) {
      throw new LocalLedgerError("ArithmeticOverflow", "escrow cannot cover payout + fee");
    }
    // The escrow PDA is the source of every lamport that leaves the round.
    r.escrowBalance -= total;
    this.credit(r.winner, r.payoutLamports);
    this.credit(this.cfg.treasury, r.feeLamports);
    this.treasuryAccrued += r.feeLamports;
    r.status = "COMPLETED";
  }

  // ------------------------------------------------------------------
  // cancel_round (refund every participant, then terminal CANCELLED)
  // ------------------------------------------------------------------

  cancelRound(roundId: bigint): void {
    const r = this.require(roundId);
    if (r.status !== "OPEN" && r.status !== "FULL") {
      throw new LocalLedgerError("InvalidRoundStatus", `status=${r.status}`);
    }
    if (r.pot === 0n) throw new LocalLedgerError("NothingToRefund");
    for (const p of r.participants) {
      this.credit(p.wallet, p.amount);
      r.escrowBalance -= p.amount;
    }
    r.status = "CANCELLED";
    r.pot = 0n;
    r.totalWeight = 0n;
  }

  // ------------------------------------------------------------------
  // lifecycle dispatcher (mirrors the operator instruction set)
  // ------------------------------------------------------------------

  runLifecycle(
    action: "create" | "lock" | "settle" | "pay" | "cancel",
    args: { roundId?: bigint; tier?: number } = {}
  ): { roundId: bigint; signature: string } {
    switch (action) {
      case "create": {
        const roundId = this.createRound(args.tier ?? 0);
        return { roundId, signature: this.fakeSignature("create", roundId) };
      }
      case "lock": {
        const id = this.requireId(args.roundId);
        this.lockRound(id);
        return { roundId: id, signature: this.fakeSignature("lock", id) };
      }
      case "settle": {
        const id = this.requireId(args.roundId);
        this.settleRound(id);
        return { roundId: id, signature: this.fakeSignature("settle", id) };
      }
      case "pay": {
        const id = this.requireId(args.roundId);
        this.payWinners(id);
        return { roundId: id, signature: this.fakeSignature("pay", id) };
      }
      case "cancel": {
        const id = this.requireId(args.roundId);
        this.cancelRound(id);
        return { roundId: id, signature: this.fakeSignature("cancel", id) };
      }
    }
  }

  private requireId(roundId: bigint | undefined): bigint {
    if (roundId === undefined) throw new LocalLedgerError("InvalidRoundStatus", "round id required");
    return roundId;
  }

  /**
   * Deterministic, signature-shaped id (64 chars) so the tx ledger, the
   * idempotence keys and the UI all work unchanged. Not a real signature.
   */
  private fakeSignature(kind: string, roundId: bigint): string {
    return this.signatureFor(kind, roundId, null, null);
  }

  /** Public form so the backend can mint a deposit id for the tx ledger. */
  signatureFor(kind: string, roundId: bigint, wallet: PublicKey | null, lamports: bigint | null): string {
    const digest = createHash("sha512")
      .update(
        `roulette:local:${kind}:${roundId}:${this.roundCounter}:` +
          `${wallet ? wallet.toBase58() : "-"}:${lamports ?? "-"}:${this.rounds.get(roundId.toString())?.participants.length ?? 0}`
      )
      .digest()
      .subarray(0, 48);
    return base58Encode(new Uint8Array(digest));
  }

  /** A stable, non-secret operator identity for local-mode bookkeeping. */
  static deriveOperator(programId: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("roulette:local-operator"), programId.toBuffer()],
      programId
    )[0];
  }
}
