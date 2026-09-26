/**
 * Instruction builders matching programs/roulette (Anchor discriminators).
 *
 * Anchor discriminator = sha256("global:" + snake_case_method)[0..8].
 * Args are borsh-encoded manually (LE) — no anchor-ts dependency.
 *
 * ACCOUNT ORDER MATTERS: Anchor matches context accounts by position. Every
 * builder below mirrors the corresponding #[derive(Accounts)] struct in
 * programs/roulette/src/state.rs field-for-field:
 *
 *   InitializeConfig: [config(w), operator(s,w), treasury(w), system]
 *   CreateRound:      [config(w), round(w), escrow, operator(s,w), system]
 *   Deposit:          [config, round(w), participant(w), escrow(w), depositor(s,w), system]
 *   LockRound:        [config, round(w), escrow, operator(s,w)]
 *   SettleRound:      [config, round(w), escrow(w), treasury, operator(s,w), slot_hashes, system] + remaining Participant PDAs (index order)
 *   PayWinners:       [config, round(w), escrow(w), winner_account(w), treasury(w), operator(s,w), system]
 *   CancelRound:      [config, round(w), escrow(w), operator(s,w), system] + remaining (Participant, wallet) pairs
 */
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { configPda, escrowPda, participantPda, roundPda, SEED_CONFIG, SEED_ESCROW, SEED_PARTICIPANT, SEED_ROUND } from "./pda.js";

/** Anchor-style 8-byte instruction discriminator. */
export function globalDiscriminator(method: string): Buffer {
  return createHash("sha256").update(`global:${method}`).digest().subarray(0, 8);
}

/** Alias used by scripts and operator tooling. */
export const anchorDiscriminator = globalDiscriminator;

const u8 = (v: number) => Buffer.from([v]);
const u16 = (v: number) => Buffer.from(new Uint16Array([v]).buffer).subarray(0, 2);
const u64 = (v: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};

export const SLOT_HASHES_SYSVAR = new PublicKey("SysvarS1otHashes11111111111111111111111111111111");

export type Meta = { pubkey: PublicKey; isSigner: boolean; isWritable: boolean };
const meta = (pubkey: PublicKey, isSigner = false, isWritable = false): Meta => ({ pubkey, isSigner, isWritable });

// ---------------------------------------------------------------------------
// initialize_config(operator: Pubkey, fee_bps, max_round_size, min_deposit, max_deposit)
// The treasury is the `treasury` ACCOUNT (frozen on config), not an arg.
// ---------------------------------------------------------------------------

export interface InitializeConfigArgs {
  operator: PublicKey;
  treasury: PublicKey;
  feeBps: number;
  maxRoundSizeLamports: bigint;
  minDepositLamports: bigint;
  maxDepositLamports: bigint;
}

export function initializeConfigIx(programId: PublicKey, args: InitializeConfigArgs): TransactionInstruction {
  const config = configPda(programId);
  const data = Buffer.concat([
    globalDiscriminator("initialize_config"),
    args.operator.toBuffer(), // first instruction arg per lib.rs
    u16(args.feeBps),
    u64(args.maxRoundSizeLamports),
    u64(args.minDepositLamports),
    u64(args.maxDepositLamports),
  ]);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(config, false, true), // init, payer = operator
      meta(args.operator, true, true), // payer/signer
      meta(args.treasury, false, true), // frozen on config; paid the fee by pay_winners
      meta(SystemProgram.programId),
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// create_round(round_id, tier) — operator only. Round id must equal the
// on-chain counter + 1 (the program enforces it); read the config first.
// ---------------------------------------------------------------------------

export function createRoundInstruction(
  programId: PublicKey,
  operator: PublicKey,
  roundId: bigint,
  tier: number
): TransactionInstruction {
  const round = roundPda(programId, roundId);
  const data = Buffer.concat([globalDiscriminator("create_round"), u64(roundId), u8(tier)]);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(configPda(programId), false, true),
      meta(round, false, true), // `zero`: created here
      meta(escrowPda(programId, round), false, true), // rent-funded escrow
      meta(operator, true, true),
      meta(SystemProgram.programId),
    ],
    data,
  });
}

export { SEED_CONFIG, SEED_ROUND, SEED_ESCROW, SEED_PARTICIPANT };

// ---------------------------------------------------------------------------
// deposit(amount) — depositor signs; funds move wallet → escrow PDA
// ---------------------------------------------------------------------------

export function depositIx(
  programId: PublicKey,
  depositor: PublicKey,
  roundId: bigint,
  amountLamports: bigint
): TransactionInstruction {
  const round = roundPda(programId, roundId);
  const data = Buffer.concat([globalDiscriminator("deposit"), u64(amountLamports)]);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(configPda(programId), false, false),
      meta(round, false, true),
      meta(participantPda(programId, round, depositor), false, true), // init_if_needed
      meta(escrowPda(programId, round), false, true),
      meta(depositor, true, true),
      meta(SystemProgram.programId),
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// lock_round() — operator only
// ---------------------------------------------------------------------------

export function lockRoundIx(programId: PublicKey, operator: PublicKey, roundId: bigint): TransactionInstruction {
  const round = roundPda(programId, roundId);
  const data = globalDiscriminator("lock_round");
  return new TransactionInstruction({
    programId,
    keys: [
      meta(configPda(programId), false, false),
      meta(round, false, true),
      meta(escrowPda(programId, round), false, false),
      meta(operator, true, true),
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// settle_round(all Participant PDAs as remaining accounts, index order) — operator only
// ---------------------------------------------------------------------------

export function settleRoundIx(
  programId: PublicKey,
  operator: PublicKey,
  roundId: bigint,
  treasury: PublicKey,
  participants: PublicKey[] // Participant PDAs in Participant.index order
): TransactionInstruction {
  const round = roundPda(programId, roundId);
  const data = globalDiscriminator("settle_round");
  return new TransactionInstruction({
    programId,
    keys: [
      meta(configPda(programId), false, false),
      meta(round, false, true),
      meta(escrowPda(programId, round), false, true),
      meta(treasury, false, false),
      meta(operator, true, true),
      meta(SLOT_HASHES_SYSVAR, false, false),
      meta(SystemProgram.programId),
      ...participants.map((p) => meta(p, false, false)),
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// pay_winners() — operator only; pays 92.5% winner + 7.5% treasury atomically
// ---------------------------------------------------------------------------

export function payWinnersIx(
  programId: PublicKey,
  operator: PublicKey,
  roundId: bigint,
  winner: PublicKey,
  treasury: PublicKey
): TransactionInstruction {
  const round = roundPda(programId, roundId);
  const data = globalDiscriminator("pay_winners");
  return new TransactionInstruction({
    programId,
    keys: [
      meta(configPda(programId), false, false),
      meta(round, false, true),
      meta(escrowPda(programId, round), false, true),
      meta(winner, false, true),
      meta(treasury, false, true),
      meta(operator, true, true),
      meta(SystemProgram.programId),
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// cancel_round((Participant, wallet) pairs as remaining accounts) — operator only
// ---------------------------------------------------------------------------

export function cancelRoundIx(
  programId: PublicKey,
  operator: PublicKey,
  roundId: bigint,
  participants: PublicKey[], // Participant PDAs, index order
  wallets: PublicKey[] // matching wallets, same order
): TransactionInstruction {
  const round = roundPda(programId, roundId);
  const data = globalDiscriminator("cancel_round");
  const pairs = participants.map((p, i) => [meta(p, false, false), meta(wallets[i]!, false, true)]);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(configPda(programId), false, false),
      meta(round, false, true),
      meta(escrowPda(programId, round), false, true),
      meta(operator, true, true),
      meta(SystemProgram.programId),
      ...pairs.flat(),
    ],
    data,
  });
}
