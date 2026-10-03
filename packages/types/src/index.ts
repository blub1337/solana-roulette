/**
 * Shared domain types for SolRoll.
 * Lamports are ALWAYS strings over the wire (no JS number precision loss).
 */

export type Lamports = string;

/** On-chain round status machine (mirrors the Anchor program, byte order). */
export type RoundState =
  | "OPEN"
  | "FULL"
  | "LOCKED"
  | "RANDOMNESS_PENDING"
  | "SETTLING"
  | "COMPLETED"
  | "CANCELLED";

export const ROUND_STATES: readonly RoundState[] = [
  "OPEN",
  "FULL",
  "LOCKED",
  "RANDOMNESS_PENDING",
  "SETTLING",
  "COMPLETED",
  "CANCELLED",
];

export const TERMINAL_STATUSES: readonly RoundState[] = ["COMPLETED", "CANCELLED"];
export const SETTLEABLE_STATUSES: readonly RoundState[] = [
  "FULL",
  "LOCKED",
  "RANDOMNESS_PENDING",
  "SETTLING",
];

export function isTerminalState(status: RoundState | string): boolean {
  return status === "COMPLETED" || status === "CANCELLED";
}

/**
 * The three fixed pool lanes. `tier` is the lane index; caps are game rules
 * enforced on-chain (GlobalConfig.tier_caps) — never by the frontend.
 */
export type Tier = 0 | 1 | 2;

export const TIER_COUNT = 3;

export const TIER_CAPS_SOL: readonly number[] = [1, 10, 100];

export interface TierMeta {
  label: string;
  shortLabel: string;
  emoji: string;
  accent: "emerald" | "sky" | "violet";
  capSol: number;
}

export const TIER_META: readonly TierMeta[] = [
  { label: "1 SOL Roll", shortLabel: "1 SOL", emoji: "🟢", accent: "emerald", capSol: 1 },
  { label: "10 SOL Roll", shortLabel: "10 SOL", emoji: "🔵", accent: "sky", capSol: 10 },
  { label: "100 SOL Roll", shortLabel: "100 SOL", emoji: "🟣", accent: "violet", capSol: 100 },
];

/** Parse a "?tier=" query param into a lane index (null when invalid). */
export function tierFromParam(param: string | null | undefined): Tier | null {
  if (!param || !/^\d+$/.test(param)) return null;
  const n = Number(param);
  return n === 0 || n === 1 || n === 2 ? (n as Tier) : null;
}

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Canonical deposit message a player signs with their own wallet.
 *
 * Shared by the browser and the API so the two can never drift. Binding the
 * round id, the exact lamport amount, the wallet and a client nonce makes the
 * signature useless anywhere else: it cannot be replayed into another round or
 * for another amount. One entry per wallet per round is enforced separately by
 * the runtime (docs/PAYMENTS.md).
 */
export function depositMessage(args: {
  roundId: bigint | string;
  amountLamports: bigint | string;
  wallet: string;
  nonce: string;
}): string {
  return `roulette:deposit:${args.roundId.toString()}:${args.amountLamports.toString()}:${args.wallet}:${args.nonce}`;
}

export function lamportsToSol(l: Lamports): number {
  return Number(BigInt(l)) / 1_000_000_000;
}

export function formatSol(l: Lamports, maxDecimals = 4): string {
  const n = lamportsToSol(l);
  const s = n.toFixed(maxDecimals);
  return s.replace(/\.?0+$/, "") || "0";
}

/** A verified participant entry of a round (audit mirror; chain is truth). */
export interface EntryDto {
  wallet: string;
  amountLamports: Lamports;
  weightStart: Lamports;
  index: number;
  verified: boolean;
}

/**
 * The refund decision window of a live round.
 *
 * A funded OPEN round that never reaches its cap is ended by the runtime (one
 * entry per wallet per round would otherwise lock the lane forever). Instead of
 * refunding silently, the players are ASKED first: take the exact refund now,
 * or keep waiting. `active` is true only while that question is on the table.
 */
export interface RefundWindow {
  /** True while a funded OPEN round is inside its decision window. */
  active: boolean;
  /** open = still filling · pending = players are being asked · refund = closing now */
  status: "open" | "pending" | "refund";
  /** How long the funded round has been observably OPEN, in ms. */
  openMs: number;
  /** Epoch ms at which the round is refunded if nobody chooses to wait. */
  deadline: number | null;
  /** Countdown to `deadline`, in ms (0 once it has passed). */
  msRemaining: number;
  /** How long the prompt itself is shown, in ms. */
  windowMs: number;
  /** True while a player may trigger the refund now. */
  canRefund: boolean;
  /** True while a player may extend the wait. */
  canWait: boolean;
}

/** Round summary DTO derived from the decoded on-chain Round account. */
export interface RoundSummary {
  id: string;
  tier: number;
  status: RoundState;
  escrow: string;
  potLamports: Lamports;
  totalWeight: string;
  participantCount: number;
  maxRoundSizeLamports: Lamports;
  minDepositLamports: Lamports;
  maxDepositLamports: Lamports;
  feeBps: number;
  lockSlot?: string;
  revealSlot?: string;
  winner?: string;
  payoutLamports?: Lamports;
  feeLamports?: Lamports;
  randomnessHex?: string;
  /**
   * The exact entropy input the program hashed (the SlotHashes entry for
   * `revealSlot`), persisted on-chain by `settle_round`. Recomputing
   * randomness from this reproduces the draw exactly.
   */
  revealInputHex?: string;
  winningTicket?: string;
  /**
   * The refund-or-wait decision window, when this round has one. Absent for a
   * round that is still filling normally, is empty, or is already settling.
   */
  refundWindow?: RefundWindow;
}

export interface VerifyCheck {
  name: string;
  pass: boolean;
  detail?: string;
}

/** Result of the independent winner recomputation (public audit trace). */
export interface VerifyResult {
  ok: boolean;
  onChainStatus?: RoundState;
  round?: RoundSummary;
  roundId?: string;
  totalWeight?: string;
  participantCount?: number;
  entropySource?: "persisted_input" | "recorded_randomness" | "recomputed_blockhash" | "unavailable";
  randomnessHex?: string;
  revealBlockhash?: string;
  revealInputHex?: string;
  ticket?: string;
  computedWinner?: string;
  recordedWinner?: string;
  recordedFeeLamports?: string;
  expectedFeeLamports?: string;
  recordedPayoutLamports?: string;
  expectedPayoutLamports?: string;
  checks?: VerifyCheck[];
}

export type SseEventType =
  | "deposit"
  | "pot"
  | "participant"
  | "round_full"
  | "lock"
  | "randomness_arrived"
  | "winner"
  | "settlement"
  | "new_round"
  | "tx"
  | "config"
  | "chat"
  | "refund_window";

export interface SseEvent {
  type: SseEventType;
  roundId?: string;
  data?: Record<string, unknown>;
  /** Epoch millis. */
  ts: number;
}
