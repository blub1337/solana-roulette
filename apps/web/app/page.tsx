"use client";

import Link from "next/link";
import { useCallback } from "react";
import { usePools } from "../hooks/usePools";
import { useRuntime } from "../hooks/useRuntime";
import { useSse } from "../hooks/useSse";
import { ModeBanner } from "../components/ModeBanner";
import { DevnetBadge } from "../components/DevnetBadge";
import { BrandLogo, BRAND_NAME } from "../components/BrandLogo";
import { TIER_META, TIER_COUNT, type Tier } from "@solana-roulette/types";

function lamportsToSol(lamports: string | null | undefined): string {
  if (!lamports) return "0";
  return (Number(lamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function shorten(pk: string | null | undefined): string {
  if (!pk) return "—";
  return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}

export default function Home() {
  const { pools, error, refresh } = usePools();
  const { runtime } = useRuntime();

  // Live updates: any settlement event re-reads the pools from the API.
  const onEvent = useCallback(() => void refresh(), [refresh]);
  useSse(onEvent);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      {/* Hero */}
      <header className="mb-8 text-center">
        <div className="mb-4 flex flex-wrap items-center justify-center gap-3">
          <span className="rounded-full border border-roulette-red/60 bg-roulette-red/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-roulette-red">
            devnet only
          </span>
          <span className="rounded-full border border-felt-600 bg-felt-900 px-3 py-1 text-xs uppercase tracking-widest text-ivory/60">
            provably fair
          </span>
          <span className="rounded-full border border-felt-600 bg-felt-900 px-3 py-1 text-xs uppercase tracking-widest text-ivory/60">
            7.5% platform fee
          </span>
        </div>
        <BrandLogo className="brand-hero h-20 w-auto sm:h-24 lg:h-28" />
        <h1 className="hero-title mt-4">SOLROLL</h1>
        <p className="mx-auto mt-4 max-w-2xl text-ivory/70">
          Three independent pools. Every stake is weighted by its size, the pot closes
          automatically at its limit, and the winner is determined deterministically —
          never by the frontend, never by us.
        </p>
      </header>

      <ModeBanner runtime={runtime} />
      <DevnetBadge />

      {error && (
        <div className="banner-error justify-center">
          <span>⚠ {error} — retrying automatically…</span>
        </div>
      )}

      {/* Three pool cards */}
      <section className="grid gap-6 md:grid-cols-3">
        {pools === null
          ? Array.from({ length: TIER_COUNT }).map((_, i) => (
              <div key={i} className="tier-card" data-tier={i}>
                <div className="skeleton h-8 w-2/3" />
                <div className="skeleton mt-4 h-3 w-1/3" />
                <div className="skeleton mt-6 h-2.5 w-full" />
                <div className="skeleton mt-3 h-2.5 w-full" />
                <div className="skeleton mt-8 h-10 w-full" />
              </div>
            ))
          : pools.map((p) => {
              const tier = p.tier as Tier;
              const meta = TIER_META[tier];
              return (
                <Link
                  key={p.tier}
                  href={`/pool/${p.tier}`}
                  className="tier-card block"
                  data-tier={p.tier}
                >
                  <div className="flex items-start justify-between">
                    <span className="text-3xl" aria-hidden>
                      {meta.emoji}
                    </span>
                    <span
                      className={`status-pill ${
                        p.status === "OPEN"
                          ? "!text-emerald-300"
                          : p.status === "COMPLETED"
                            ? "!text-gold-300"
                            : "!text-amber-300"
                      }`}
                    >
                      {p.status === "OPENING"
                        ? "Opening"
                        : p.status === "OPEN"
                          ? "Accepting deposits"
                          : p.status}
                    </span>
                  </div>
                  <h2 className="mt-3 font-display text-2xl text-ivory">{meta.label}</h2>
                  <p className="mt-1 text-xs text-ivory/50">
                    {meta.shortLabel} max pool volume per round
                  </p>

                  <div className="mt-5 flex items-end justify-between font-mono">
                    <span className="text-2xl text-gold-300">
                      {lamportsToSol(p.potLamports)}
                      <span className="text-sm text-ivory/50"> / {p.capSol} SOL</span>
                    </span>
                    <span className="text-sm text-ivory/60">{p.fillPercent.toFixed(1)}%</span>
                  </div>

                  <div className="pool-track mt-2">
                    <div
                      className="pool-fill"
                      data-tier={p.tier}
                      style={{ width: `${Math.max(0, Math.min(100, p.fillPercent))}%` }}
                      role="progressbar"
                      aria-valuenow={p.fillPercent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    />
                  </div>

                  <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <dt className="stat-label">Players</dt>
                      <dd className="text-gold-300">{p.participantCount}</dd>
                    </div>
                    <div>
                      <dt className="stat-label">Round</dt>
                      <dd className="text-gold-300">#{p.roundId ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="stat-label">Last winner</dt>
                      <dd className="font-mono text-xs text-ivory/70">
                        {shorten(p.winner ?? p.lastWinner)}
                      </dd>
                    </div>
                    <div>
                      <dt className="stat-label">Last payout</dt>
                      <dd className="text-gold-300">
                        {p.payoutLamports ?? p.lastPayoutLamports
                          ? `${lamportsToSol((p.payoutLamports ?? p.lastPayoutLamports)!)} ◎`
                          : "—"}
                      </dd>
                    </div>
                  </dl>

                  <div className="mt-6 flex items-center justify-between">
                    <span className="text-sm font-semibold text-gold-300">Enter table →</span>
                    <span className="text-xs text-ivory/40">
                      {p.status === "OPEN" ? "deposits open" : "in settlement"}
                    </span>
                  </div>
                </Link>
              );
            })}
      </section>

      {/* Fee split */}
      <section className="panel mt-6 flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <h2 className="font-display text-lg text-gold-300">How every pot is split</h2>
          <p className="mt-1 text-sm text-ivory/60">
            Integer lamport math, applied by the runtime — 10 SOL → 0.75 SOL fee + 9.25 SOL
            payout. The fee wallet only ever receives the commission.
          </p>
        </div>
        <div className="flex items-center gap-4 font-mono text-sm">
          <span className="text-gold-300">92.5% winner</span>
          <span aria-hidden className="text-ivory/30">
            |
          </span>
          <span className="text-ivory/70">7.5% fee</span>
        </div>
      </section>

      {/* How it works */}
      <section className="mt-6 grid gap-6 md:grid-cols-3">
        {[
          {
            t: "1 — Deposit",
            d: "Connect Phantom or Solflare and join the pool. One entry per wallet per round; your weight equals your stake, so your odds are simply your share of the pot.",
          },
          {
            t: "2 — Lock & reveal",
            d: "The instant the pool hits its limit the round closes and commits a future slot. Once that slot passes, the outcome is derived and frozen — unknowable at lock time.",
          },
          {
            t: "3 — Atomic payout",
            d: "92.5% goes to the winner and 7.5% to the fee wallet in one atomic step, then the next round opens automatically. No admin, no manual payout.",
          },
        ].map((s) => (
          <div key={s.t} className="panel p-6">
            <h3 className="font-display text-lg text-gold-300">{s.t}</h3>
            <p className="mt-2 text-sm leading-relaxed text-ivory/70">{s.d}</p>
          </div>
        ))}
      </section>

      <footer className="mt-12 border-t border-felt-700 pt-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <BrandLogo className="h-10 w-auto opacity-90" />
          <p className="text-xs text-ivory/40">
            {BRAND_NAME} · DEVNET demonstration. No real-money wagering. The winner is determined
            by the runtime and is independently verifiable — see{" "}
            <Link href="/admin" className="text-gold-400 hover:text-gold-300">
              the audit monitor
            </Link>{" "}
            and docs/VERIFICATION.md.
          </p>
        </div>
      </footer>
    </main>
  );
}
