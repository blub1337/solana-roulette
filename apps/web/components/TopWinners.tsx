"use client";

/**
 * Top winners — the same look as the live chat, but the content is each pool's
 * top 5 all-time winners.
 *
 * Data comes from `GET /api/history` (completed rounds, rebuilt from the chain),
 * which already carries the settled `payoutLamports`, `winner` and `tier`. We
 * rank by the ACTUAL payout, not the pot, and keep the on-chain round id as a
 * tie-breaker. The panel refreshes on settlement events over SSE.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE } from "../lib/apiBase";
import { useSse, type SseMessage } from "../hooks/useSse";
import { TIER_META, TIER_COUNT, type Tier } from "@solana-roulette/types";

interface HistoryRound {
  id: string;
  tier: number;
  status: string;
  winner: string | null;
  payoutLamports: string | null;
  pot: string;
  completedAt: string | null;
}

const TOP_N = 5;

const short = (pk: string) => (pk.length > 12 ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : pk);
const sol = (l: string) => (Number(l) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 3 });

/** Rank by payout desc, then by newer on-chain round id. */
function byPayoutDesc(a: HistoryRound, b: HistoryRound): number {
  const pa = BigInt(a.payoutLamports ?? "0");
  const pb = BigInt(b.payoutLamports ?? "0");
  if (pa !== pb) return pb > pa ? 1 : -1;
  const ia = BigInt(a.id);
  const ib = BigInt(b.id);
  return ib > ia ? 1 : ib < ia ? -1 : 0;
}

export function TopWinners({ className = "" }: { className?: string }) {
  const [rounds, setRounds] = useState<HistoryRound[] | null>(null);

  const load = useCallback(() => {
    fetch(`${API_BASE}/api/history`)
      .then((r) => (r.ok ? r.json() : { rounds: [] }))
      .then((d: { rounds?: HistoryRound[] }) => setRounds(Array.isArray(d.rounds) ? d.rounds : []))
      .catch(() => setRounds([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Refresh whenever anything settles (ignore chat noise).
  const onEvent = useCallback(
    (ev: SseMessage) => {
      if (ev.type !== "chat") load();
    },
    [load]
  );
  useSse(onEvent);

  const byTier = useMemo(() => {
    const out: Record<number, HistoryRound[]> = {};
    for (let t = 0; t < TIER_COUNT; t++) out[t] = [];
    for (const r of rounds ?? []) {
      if (!r.winner || !r.payoutLamports) continue;
      (out[r.tier] ??= []).push(r);
    }
    for (const key of Object.keys(out)) {
      const t = Number(key);
      out[t] = out[t].slice().sort(byPayoutDesc).slice(0, TOP_N);
    }
    return out;
  }, [rounds]);

  return (
    <div
      className={`flex h-[30rem] flex-col overflow-hidden rounded-2xl border border-felt-600/70 bg-felt-950/95 shadow-gold-glow backdrop-blur ${className}`}
    >
      <header className="flex items-center justify-between border-b border-felt-700/70 px-4 py-3">
        <div>
          <h2 className="font-display text-sm text-gold-300">Top winners</h2>
          <p className="text-[11px] text-ivory/50">Top {TOP_N} all-time · per pool</p>
        </div>
        <span className="text-lg" aria-hidden>
          🏆
        </span>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {rounds === null && <p className="pt-8 text-center text-xs text-ivory/40">Loading winners…</p>}
        {rounds !== null &&
          Array.from({ length: TIER_COUNT }).map((_, tier) => {
            const meta = TIER_META[tier as Tier];
            const rows = byTier[tier] ?? [];
            return (
              <div key={tier}>
                <div className="mb-1.5 flex items-center gap-2 text-[11px] uppercase tracking-wider text-ivory/50">
                  <span aria-hidden>{meta.emoji}</span>
                  <span>{meta.label}</span>
                </div>
                {rows.length === 0 ? (
                  <p className="pl-1 text-xs text-ivory/35">No winners yet.</p>
                ) : (
                  <ol className="space-y-1">
                    {rows.map((r, i) => (
                      <li
                        key={r.id}
                        className="flex items-center justify-between gap-2 rounded-lg border border-felt-700 bg-felt-900/80 px-2.5 py-1.5 text-xs"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="w-3 text-gold-300/70">{i + 1}</span>
                          <span className="truncate font-mono text-ivory/80">{short(r.winner!)}</span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block font-mono text-gold-300">{sol(r.payoutLamports!)} ◎</span>
                          <span className="block text-[10px] text-ivory/40">#{r.id}</span>
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
