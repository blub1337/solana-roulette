/**
 * Fee display helpers.
 *
 * The percentage is deliberately never written into the markup: it is derived
 * from the bps the API reports in `/api/config`, and that value is the fee the
 * runtime actually enforces (on-chain GlobalConfig in chain mode, the
 * environment in local mode — see apps/api/src/feeTerms.ts). Hard-coding "2%"
 * or "7.5%" in a page is exactly how the UI and the payout drifted apart, so
 * every percentage on the site comes from here.
 *
 * Pure functions only: no fetching, no React.
 */

const BPS_DENOMINATOR = 10_000;
const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Pot size of the worked example on the landing page ("10 SOL → … "). */
export const FEE_EXAMPLE_POT_SOL = 10;

export interface FeeTerms {
  feeBps: number;
  /** "2", "7.5", "2.5" — trailing zeros trimmed. */
  feePercent: string;
  /** 100 − fee, formatted the same way. */
  winnerPercent: string;
  /** Integer-lamport split of `FEE_EXAMPLE_POT_SOL`, e.g. 0.2 + 9.8. */
  example: { feeSol: string; payoutSol: string };
}

/** Basis points → percent, without trailing zeros: 200 → "2", 250 → "2.5". */
export function formatPercent(bps: number): string {
  return (bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Lamports → SOL, without trailing zeros: 200_000_000n → "0.2". */
function formatSol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const frac = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * Everything a page needs to talk about the fee, derived from the enforced bps.
 * The arithmetic runs in BigInt so the example matches the program's integer
 * lamport math instead of drifting through floating point.
 */
export function feeTermsFrom(feeBps: number): FeeTerms {
  const bps = BigInt(Math.round(feeBps));
  const pot = BigInt(FEE_EXAMPLE_POT_SOL) * LAMPORTS_PER_SOL;
  const fee = (pot * bps) / BigInt(BPS_DENOMINATOR);
  return {
    feeBps: Number(bps),
    feePercent: formatPercent(Number(bps)),
    winnerPercent: formatPercent(BPS_DENOMINATOR - Number(bps)),
    example: { feeSol: formatSol(fee), payoutSol: formatSol(pot - fee) },
  };
}
