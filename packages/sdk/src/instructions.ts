/**
 * Instruction builders matching programs/roulette (Anchor discriminators).
 *
 * Anchor discriminator = sha256("global:" + snake_case_method)[0..8].
 * Args are borsh-encoded manually (LE) — no anchor-ts dependency.
 *
 * settle_round / cancel_round receive ALL participant accounts as remaining
 * accounts (index order); `max_participants` in GlobalConfig bounds this so a
 * transaction always fits (≤ 64 legacy accounts).
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
const u32 = (v: number) => Buffer.from(new Uint32Array([v]).buffer).subarray(0, 4);
const u64 = (v: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};

export const SLOT_HASHES_SYSVAR = new PublicKey("SysvarS1otHashes11111111111111111111111111111111");

export type Meta = { pubkey: PublicKey; isSigner: boolean; isWritable: boolean };
const meta = (pubkey: PublicKey, isSigner = false, isWritable = false): Meta => ({ pubkey, isSigner, isWritable });

// ---------------------------------------------------------------------------
// initialize_config(operator, treasury, fee_bps, max_round_size, min, max, reveal_offset, max_participants)
// ---------------------------------------------------------------------------

export interface InitializeConfigArgs {
  operator: PublicKey;
  treasury: PublicKey;
  feeBps: number;
  maxRoundSizeLamports: bigint;
  minDepositLamports: bigint;
  maxDepositLamports: bigint;
  revealOffsetSlots: number;
  maxParticipants: number;
}

export function initializeConfigIx(programId: PublicKey, args: InitializeConfigArgs): TransactionInstruction {
  const config = configPda(programId);
  const data = Buffer.concat([
    globalDiscriminator("initialize_config"),
    args.operator.toBuffer(),
    args.treasury.toBuffer(),
    u16(args.feeBps),
    u64(args.maxRoundSizeLamports),
    u64(args.minDepositLamports),
    u64(args.maxDepositLamports),
    u64(args.revealOffsetSlots),
    u32(args.maxParticipants),
  ]);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(args.operator, true, true), // payer
      meta(config, false, true), // init
      meta(args.treasury, false, false), // frozen at init
      meta(SystemProgram.programId),
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// create_round(round_id, tier) — operator only. Round id comes from the
// operator's counter cache (read from the config account before building the
// tx); the program validates the PDA seeds match `config.round_counter`.
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
      meta(operator, true, true),
      meta(configPda(programId), false, true),
      meta(round, false, true),
      meta(escrowPda(programId, round), false, true),
      meta(SystemProgram.programId),
    ],
    data,
  });
}

export { SEED_CONFIG, SEED_ROUND, SEED_ESCROW, SEED_PARTICIPANT };

// ---------------------------------------------------------------------------
// deposit(amount) — depositor signs
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
      meta(depositor, true, true),
      meta(configPda(programId), false, false),
      meta(round, false, true),
      meta(escrowPda(programId, round), false, true),
      meta(participantPda(programId, round, depositor), false, true),
      meta(SystemProgram.programId),
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// lock_round() — operator only
// ---------------------------------------------------------------------------

export function lockRoundIx(programId: PublicKey, operator: PublicKey, roundId: bigint): TransactionInstruction {
  const data = globalDiscriminator("lock_round");
  return new TransactionInstruction({
    programId,
    keys: [
      meta(operator, true, true),
      meta(configPda(programId), false, false),
      meta(roundPda(programId, roundId), false, true),
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// settle_round(all participants as remaining accounts) — operator only
// ---------------------------------------------------------------------------

export function settleRoundIx(
  programId: PublicKey,
  operator: PublicKey,
  roundId: bigint,
  treasury: PublicKey,
  participants: PublicKey[] // index order — must match Participant.index
): TransactionInstruction {
  const round = roundPda(programId, roundId);
  const data = globalDiscriminator("settle_round");
  return new TransactionInstruction({
    programId,
    keys: [
      meta(operator, true, true),
      meta(round, false, true),
      meta(escrowPda(programId, round), false, true),
      meta(treasury, false, true),
      meta(SLOT_HASHES_SYSVAR, false, false),
      ...participants.map((p) => meta(p, false, true)),
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// cancel_round(refunds every participant) — operator only
// ---------------------------------------------------------------------------

export function cancelRoundIx(
  programId: PublicKey,
  operator: PublicKey,
  roundId: bigint,
  participants: PublicKey[]
): TransactionInstruction {
  const round = roundPda(programId, roundId);
  const data = globalDiscriminator("cancel_round");
  return new TransactionInstruction({
    programId,
    keys: [
      meta(operator, true, true),
      meta(round, false, true),
      meta(escrowPda(programId, round), false, true),
      ...participants.map((p) => meta(p, false, true)),
    ],
    data,
  });
}
