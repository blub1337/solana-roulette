"use client";

import { useMemo } from "react";

export interface WheelEntry {
  id: string;
  weight: number;
}

export interface RoundWheelProps {
  entries: WheelEntry[];
  winner: string | null;
  spinning: boolean;
  /** Pool lane — picks the accent hue (0=emerald, 1=sky, 2=violet). */
  tier: number;
}

const HUES = [172, 199, 45]; // teal / sky / gold per tier (matches logo palette)

/**
 * Displays the entry pool as a proportionally-sized segmented disc in the
 * tier's accent color. When the winner is known, the overlay reflects the
 * ALREADY DETERMINED winner — the wheel never picks one.
 */
export function RoundWheel({ entries, winner, spinning, tier }: RoundWheelProps) {
  const total = entries.reduce((a, e) => a + e.weight, 0);
  const hue = HUES[tier] ?? HUES[0];

  const segments = useMemo(() => {
    let acc = 0;
    return entries.map((e, i) => {
      const start = acc;
      acc += e.weight;
      return {
        id: e.id,
        pct: total > 0 ? (e.weight / total) * 100 : 0,
        from: total > 0 ? (start / total) * 100 : 0,
        // Subtle lightness variation keeps adjacent same-size entries readable.
        light: 38 + (i % 4) * 6,
      };
    });
  }, [entries, total]);

  return (
    <div className="relative mx-auto aspect-square w-56 sm:w-64" aria-label="entry pool wheel">
      <div
        className={`absolute inset-0 rounded-full border-[10px] border-gold-600/90 bg-felt-950 shadow-[0_0_60px_rgba(230,185,60,0.15)] ${
          spinning ? "animate-spin-slow" : ""
        }`}
      >
        {segments.length === 0 ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-ivory/40">
            <span className="text-xs uppercase tracking-widest">empty pot</span>
          </div>
        ) : (
          segments.map((s) => (
            <div
              key={s.id}
              className="absolute inset-0 rounded-full"
              style={{
                background: `conic-gradient(from ${s.from * 3.6}deg, hsl(${hue} 60% ${s.light}%) 0deg, hsl(${hue} 60% ${s.light}%) ${s.pct * 3.6}deg, transparent ${s.pct * 3.6}deg)`,
              }}
            />
          ))
        )}
        {/* hub */}
        <div className="absolute inset-[38%] rounded-full border border-gold-600/40 bg-felt-950/90 backdrop-blur-sm" />
        {winner && (
          <div className="winner-pop absolute inset-[24%] flex items-center justify-center rounded-full border-2 border-gold-400 bg-felt-950/90 shadow-gold-glow">
            <div className="text-center">
              <div className="stat-label">winner</div>
              <div className="font-mono text-xs text-gold-300 sm:text-sm">
                {winner.slice(0, 4)}…{winner.slice(-4)}
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="absolute left-1/2 top-[-14px] -translate-x-1/2 text-2xl text-gold-400 drop-shadow">▼</div>
    </div>
  );
}
