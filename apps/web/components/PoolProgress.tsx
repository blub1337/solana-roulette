"use client";

/** Live pool meter: pot/cap, shimmering tier-colored progress bar, participants. */
export function PoolProgress({
  tier,
  potSol,
  capSol,
  fillPercent,
  participantCount,
}: {
  tier: number;
  potSol: string;
  capSol: string;
  fillPercent: number;
  participantCount: number;
}) {
  const pct = Math.max(0, Math.min(100, fillPercent));
  return (
    <div>
      <div className="mb-2 flex items-end justify-between gap-2">
        <div className="font-mono text-lg text-ivory sm:text-xl">
          {potSol} <span className="text-ivory/50">/ {capSol} SOL</span>
        </div>
        <div className="text-sm text-ivory/60">{pct.toFixed(1)}%</div>
      </div>
      <div className="pool-track">
        <div className="pool-fill" data-tier={tier} style={{ width: `${pct}%` }} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} />
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-ivory/50">
        <span>
          <span className="text-gold-300">{participantCount}</span>{" "}
          {participantCount === 1 ? "player" : "players"}
        </span>
        <span>closes automatically at {capSol} SOL</span>
      </div>
    </div>
  );
}
