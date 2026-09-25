"use client";

import { useCallback, useEffect, useState } from "react";
import type { RoundSummary, EntryDto } from "@solana-roulette/types";
import { API_BASE } from "../lib/apiBase";

const API = API_BASE; // production-safe API base (same-origin in dev); tier routes below

interface RoundResponse {
  round: RoundSummary | null;
  entries: EntryDto[];
}

/**
 * Live state of ONE tier's current round (three independent pool lanes).
 * `tier` selects the lane (0=1 SOL, 1=10 SOL, 2=100 SOL). `refresh` re-reads on
 * demand so SSE events can drive the UI.
 */
export function useRoundState(tier: number, pollMs = 5000) {
  const [round, setRound] = useState<RoundSummary | null>(null);
  const [entries, setEntries] = useState<EntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/round/current?tier=${tier}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const json: RoundResponse = await res.json();
      setRound(json.round);
      setEntries(json.entries ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load round");
    } finally {
      setLoading(false);
    }
  }, [tier]);

  useEffect(() => {
    void refresh();
    const poll = setInterval(() => void refresh(), pollMs);
    const onDeposit = () => void refresh();
    window.addEventListener("roulette:deposit", onDeposit);
    return () => {
      clearInterval(poll);
      window.removeEventListener("roulette:deposit", onDeposit);
    };
  }, [refresh, pollMs]);

  return { round, entries, loading, error, refresh };
}
