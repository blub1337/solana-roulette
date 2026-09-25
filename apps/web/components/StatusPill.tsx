import { TIER_META, type RoundState, type Tier } from "@solana-roulette/types";

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Accepting deposits",
  FULL: "Round full",
  LOCKED: "Locked",
  RANDOMNESS_PENDING: "Choosing winner",
  SETTLING: "Settling",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export function StatusPill({ status }: { status: string }) {
  const label = STATUS_LABEL[status] ?? status;
  return (
    <span className="status-pill" data-status={status}>
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          status === "OPEN"
            ? "bg-emerald-400"
            : status === "COMPLETED"
              ? "bg-gold-400"
              : status === "CANCELLED"
                ? "bg-roulette-red"
                : "animate-pulse bg-amber-400"
        }`}
      />
      {label}
    </span>
  );
}

/** Tier badge (emoji + label) shared by cards and pool rooms. */
export function TierBadge({ tier, size = "md" }: { tier: number; size?: "sm" | "md" | "lg" }) {
  const meta = TIER_META[tier as Tier];
  if (!meta) return null;
  const sizes = {
    sm: "text-sm",
    md: "text-base",
    lg: "text-xl sm:text-2xl",
  } as const;
  return (
    <span className={`inline-flex items-center gap-2 font-display font-semibold ${sizes[size]}`}>
      <span aria-hidden>{meta.emoji}</span>
      <span className="text-ivory">{meta.label}</span>
    </span>
  );
}
