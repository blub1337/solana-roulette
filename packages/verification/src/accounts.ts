/**
 * On-chain account layouts + decoders for programs/roulette.
 * Must match the Rust structs field-for-field (docs/SMART_CONTRACT.md §1).
 * Anchor layout: 8-byte discriminator, then fields little-endian, no padding.
 */
import { PublicKey } from "@solana/web3.js";
import type { RoundState } from "@solana-roulette/types";
import { ROUND_STATES } from "@solana-roulette/types";

export const DISCRIMINATOR_LEN = 8;

// space = 8 + sum(field sizes), little-endian, no padding (Anchor borsh layout)
export const GLOBAL_CONFIG_SPACE = 8 + 32 + 32 + 2 + 8 + 8 + 8 + 8 + 8 + 24 + 1; // 139 (incl. tier_caps 3×u64)
export const ROUND_SPACE =
  8 + // discriminator
  8 + // id
  1 + // status u8
  32 + // escrow
  8 + // pot
  16 + // total_weight u128
  4 + // participant_count u32
  8 + // lock_slot
  8 + // reveal_slot
  2 + // fee_bps
  32 + // randomness
  16 + // winning_ticket u128
  32 + // winner
  8 + // fee_lamports
  8 + // payout_lamports
  32 + // payout_account (frozen winner pubkey at settle phase 1)
  1 + // tier
  1; // bump
export const PARTICIPANT_SPACE = 8 + 32 + 32 + 8 + 16 + 4 + 1; // 101

export class AccountDecodeError extends Error {
  constructor(account: string, reason: string) {
    super(`Failed to decode ${account}: ${reason}`);
    this.name = "AccountDecodeError";
  }
}

export interface GlobalConfigData {
  operator: PublicKey;
  treasury: PublicKey;
  feeBps: number;
  maxRoundSize: bigint;
  minDeposit: bigint;
  maxDeposit: bigint;
  revealOffset: bigint;
  /** Counter of created rounds (create_round enforces next == counter+1). */
  roundCounter: bigint;
  /** Max total pool volume per tier in lamports (index = tier; 1/10/100 SOL). */
  tierCaps: [bigint, bigint, bigint];
  bump: number;
}

export interface RoundData {
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
  /** 32-byte pubkey frozen at settle phase 1; zeroed until then. */
  payoutAccount: Uint8Array;
  /** Pool lane (index into GlobalConfig.tier_caps): 0=1 SOL, 1=10 SOL, 2=100 SOL. */
  tier: number;
  bump: number;
}

export interface ParticipantData {
  round: PublicKey;
  wallet: PublicKey;
  amount: bigint;
  weightStart: bigint;
  index: number;
  bump: number;
}

class Reader {
  private view: DataView;
  private o: number;
  constructor(private data: Uint8Array, start: number) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.o = start;
  }
  pubkey(): PublicKey {
    const p = new PublicKey(this.data.slice(this.o, this.o + 32));
    this.o += 32;
    return p;
  }
  u8(): number {
    return this.view.getUint8(this.o++);
  }
  u16(): number {
    const v = this.view.getUint16(this.o, true);
    this.o += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.o, true);
    this.o += 4;
    return v;
  }
  u64(): bigint {
    const v = this.view.getBigUint64(this.o, true);
    this.o += 8;
    return v;
  }
  u128(): bigint {
    const lo = this.view.getBigUint64(this.o, true);
    const hi = this.view.getBigUint64(this.o + 8, true);
    this.o += 16;
    return (hi << 64n) | lo;
  }
  bytes(n: number): Uint8Array {
    const out = new Uint8Array(this.data.slice(this.o, this.o + n));
    this.o += n;
    return out;
  }
  get offset(): number {
    return this.o;
  }
}

export function decodeGlobalConfig(data: Uint8Array): GlobalConfigData {
  if (data.length < GLOBAL_CONFIG_SPACE) throw new AccountDecodeError("GlobalConfig", "too short");
  const r = new Reader(data, DISCRIMINATOR_LEN);
  const operator = r.pubkey();
  const treasury = r.pubkey();
  const feeBps = r.u16();
  const maxRoundSize = r.u64();
  const minDeposit = r.u64();
  const maxDeposit = r.u64();
  const revealOffset = r.u64();
  const roundCounter = r.u64();
  const tierCaps: [bigint, bigint, bigint] = [r.u64(), r.u64(), r.u64()];
  const bump = r.u8();
  return {
    operator,
    treasury,
    feeBps,
    maxRoundSize,
    minDeposit,
    maxDeposit,
    revealOffset,
    roundCounter,
    tierCaps,
    bump,
  };
}

export function decodeRound(data: Uint8Array): RoundData {
  if (data.length < ROUND_SPACE) throw new AccountDecodeError("Round", "too short");
  const r = new Reader(data, DISCRIMINATOR_LEN);
  const id = r.u64();
  const statusByte = r.u8();
  const escrow = r.pubkey();
  const pot = r.u64();
  const totalWeight = r.u128();
  const participantCount = r.u32();
  const lockSlot = r.u64();
  const revealSlot = r.u64();
  const feeBps = r.u16();
  const randomness = r.bytes(32);
  const winningTicket = r.u128();
  const winner = r.pubkey();
  const feeLamports = r.u64();
  const payoutLamports = r.u64();
  const payoutAccount = r.bytes(32);
  const tier = r.u8();
  const bump = r.u8();
  const status = ROUND_STATES[statusByte] as RoundState | undefined;
  if (!status) throw new AccountDecodeError("Round", `unknown status byte ${statusByte}`);
  return {
    id,
    status,
    escrow,
    pot,
    totalWeight,
    participantCount,
    lockSlot,
    revealSlot,
    feeBps,
    randomness,
    winningTicket,
    winner,
    feeLamports,
    payoutLamports,
    payoutAccount,
    tier,
    bump,
  };
}

export function decodeParticipant(data: Uint8Array): ParticipantData {
  if (data.length < PARTICIPANT_SPACE) throw new AccountDecodeError("Participant", "too short");
  const r = new Reader(data, DISCRIMINATOR_LEN);
  return {
    round: r.pubkey(),
    wallet: r.pubkey(),
    amount: r.u64(),
    weightStart: r.u128(),
    index: r.u32(),
    bump: r.u8(),
  };
}
