/**
 * Pure winner-selection math — mirrors programs/roulette/src/winner.rs exactly:
 *
 *   ticket = u128(randomness[0..16] LE) % total_weight
 *   winner = participant whose [weight_start, weight_start + amount) contains ticket
 *
 * Dependency-free (no node builtins) so it is safe in Node, browsers and
 * bundles. Entropy derivation lives in the environment-specific entries:
 * `winner.ts` (node:crypto, sync) and `winner.browser.ts` (WebCrypto, async).
 * Property-tested against the same invariants the Rust program must uphold.
 */

export interface WeightedEntry {
  /** Participant identifier (wallet base58). */
  id: string;
  /** Weight = deposited lamports. */
  amount: bigint;
  /** Cumulative start of this participant's range. */
  weightStart: bigint;
  /** Join order (0-based). */
  index: number;
}

export class EmptyRoundError extends Error {
  constructor() {
    super("cannot select a winner from an empty round");
    this.name = "EmptyRoundError";
  }
}

export class WeightMismatchError extends Error {
  constructor(detail: string) {
    super(`weight chain invariant violated: ${detail}`);
    this.name = "WeightMismatchError";
  }
}

/** ticket = u128(randomness[0..16] LE) % total_weight (matches Rust). */
export function computeTicket(randomness: Uint8Array, totalWeight: bigint): bigint {
  if (totalWeight <= 0n) throw new WeightMismatchError("total weight must be positive");
  const lo = u128FromLeBytes(randomness, 0);
  return lo % totalWeight;
}

/** 128-bit LE read (DataView lacks getBigUint128). */
function u128FromLeBytes(bytes: Uint8Array, offset: number): bigint {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lo = dv.getBigUint64(offset, true);
  const hi = dv.getBigUint64(offset + 8, true);
  return (hi << 64n) | lo;
}

/**
 * Deterministic weighted selection for an ALREADY-COMPUTED ticket.
 * Half-open ranges: [weight_start, weight_start + amount).
 * Validates the FULL cumulative chain first (sorted by index — the on-chain
 * account order), then walks it; any gap/overlap/zero-weight anomaly throws
 * WeightMismatchError regardless of where the ticket lands.
 */
export function selectWinner(
  entries: WeightedEntry[],
  ticket: bigint
): { id: string; index: number } {
  if (entries.length === 0) throw new EmptyRoundError();

  const sorted = [...entries].sort((a, b) => a.index - b.index);
  let cumulative = 0n;
  for (const e of sorted) {
    if (e.weightStart !== cumulative) {
      throw new WeightMismatchError(
        `entry ${e.id} weightStart=${e.weightStart} expected=${cumulative}`
      );
    }
    if (e.amount <= 0n) {
      throw new WeightMismatchError(`entry ${e.id} has non-positive amount ${e.amount}`);
    }
    cumulative += e.amount;
  }
  if (ticket >= cumulative) {
    throw new WeightMismatchError(`ticket ${ticket} exceeds total weight ${cumulative}`);
  }

  let acc = 0n;
  for (const e of sorted) {
    acc += e.amount;
    if (ticket < acc) {
      return { id: e.id, index: e.index };
    }
  }
  throw new WeightMismatchError("selection walked past total weight — unreachable");
}

/** Fee split with floor: fee = pot * fee_bps / 10_000; payout = pot - fee. */
export function computeFeeSplit(pot: bigint, feeBps: number): { fee: bigint; payout: bigint } {
  if (feeBps < 0 || feeBps > 10_000) {
    throw new WeightMismatchError(`fee bps out of range: ${feeBps}`);
  }
  const fee = (pot * BigInt(feeBps)) / 10_000n;
  const payout = pot - fee;
  return { fee, payout };
}

/**
 * Full pipeline: entropy bytes → ticket → winner.
 * `totalWeight` must equal Σ entry.amount (validated by selectWinner).
 */
export function resolveWinner(
  entries: WeightedEntry[],
  entropy: Uint8Array,
  totalWeight: bigint
): { winner: WeightedEntry; ticket: bigint } {
  const ticket = computeTicket(entropy, totalWeight);
  const { id, index } = selectWinner(entries, ticket);
  const winner = entries.find((e) => e.id === id && e.index === index);
  if (!winner) throw new WeightMismatchError(`selected winner ${id} not found in entries`);
  return { winner, ticket };
}
