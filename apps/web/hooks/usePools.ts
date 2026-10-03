"use client";

import { useCallback, useEffect, useState } from "react";
import type { RefundWindow } from "@solana-roulette/types";
import { API_BASE } from "../lib/apiBase";

const API = API_BASE; // production-safe API base (same-origin in dev)

export interface PoolDto {
  tier: number;
  label: string;
  capSol: string | number;
  emoji: string;
  accent: "emerald" | "sky" | "violet";
  capLamports: string;
  roundId: string | null;
  status: string;
  potLamports: string;
  totalWeight: string;
  participantCount: number;
  fillPercent: number;
  winner: string | null;
  payoutLamports: string | null;
  feeLamports: string | null;
  escrow: string | null;
  lastCompletedRoundId: string | null;
  /** Previous round's result, shown while the next round is already open. */
  lastWinner?: string | null;
  lastPayoutLamports?: string | null;
  lastFeeLamports?: string | null;
  /**
   * Present once the runtime is asking the players whether to take their
   * deposit back or keep waiting. Null while the round is filling normally.
   */
  refundWindow?: RefundWindow | null;
}

/** Live state of all three pool lanes. `refresh` re-reads on demand (SSE). */
export function usePools(pollMs = 5000) {
  const [pools, setPools] = useState<PoolDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/pools`, { cache: "no-store" });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const json: { pools: PoolDto[] } = await res.json();
      setPools(json.pools);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load pools");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  return { pools, error, refresh };
}
