"use client";

import type { RuntimeInfo } from "../hooks/useRuntime";

/**
 * States plainly which runtime is live and whether REAL devnet SOL moves.
 * When custody is not configured the banner says so instead of implying that
 * a deposit is safe or real.
 */
export function ModeBanner({ runtime }: { runtime: RuntimeInfo | null }) {
  if (!runtime) {
    return (
      <div className="mb-6 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-xs text-ivory/50">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ivory/40" />
        Connecting to the API…
      </div>
    );
  }

  const custody = runtime.custody;
  const live = runtime.realFunds && custody?.custodyReady === true;

  return (
    <div
      role="status"
      data-mode={runtime.mode}
      data-custody={live ? "onchain" : "unavailable"}
      className={`mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-4 py-3 text-xs sm:text-sm ${
        live
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
          : "border-amber-500/40 bg-amber-500/10 text-amber-200"
      }`}
    >
      <span
        className={`inline-block h-2 w-2 shrink-0 rounded-full ${live ? "bg-emerald-400" : "bg-amber-400"}`}
        aria-hidden
      />
      <span className="font-semibold uppercase tracking-widest">
        {live ? "Real devnet transactions" : "Deposits paused"}
      </span>
      <span className="text-ivory/70">
        {live
          ? "Deposits are signed by your wallet as a real System Program transfer into the round escrow, and winners are paid by a real devnet transfer. Every entry counts only after the chain confirms it."
          : custody?.custodyReason ??
            "The server has no devnet escrow configured, so deposits are refused rather than simulated."}
      </span>
      {runtime.platformFeeWallet && (
        <span className="ml-auto font-mono text-[11px] text-ivory/50">
          fee wallet {runtime.platformFeeWallet.slice(0, 4)}…{runtime.platformFeeWallet.slice(-4)}
        </span>
      )}
    </div>
  );
}
