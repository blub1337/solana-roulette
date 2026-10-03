"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
 *
 * The state is KEYED to the tier it was fetched for and is dropped the moment
 * `tier` changes. Without that, navigating from one pool to another kept the
 * previous lane's round in state until the new read resolved, and a deposit
 * clicked inside that window was built against the OLD lane's round id — which
 * the server correctly rejected with `already_deposited` ("this wallet already
 * has a confirmed entry in this round"). Now an out-of-lane response is
 * discarded and the panel reads as loading, so a deposit can only ever target
 * the round it is actually showing.
 */
export function useRoundState(tier: number, pollMs = 5000) {
  const [state, setState] = useState<{ tier: number; round: RoundSummary | null; entries: EntryDto[] }>({
    tier,
    round: null,
    entries: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The lane currently being rendered, so a late response from a lane the user
  // has navigated away from can be recognised and dropped.
  const currentTier = useRef(tier);
  currentTier.current = tier;

  const refresh = useCallback(async () => {
    const forTier = tier;
    try {
      const res = await fetch(`${API}/api/round/current?tier=${forTier}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const json: RoundResponse = await res.json();
      if (currentTier.current !== forTier) return; // stale lane — never apply
      setState({ tier: forTier, round: json.round, entries: json.entries ?? [] });
      setError(null);
    } catch (e) {
      if (currentTier.current !== forTier) return;
      setError(e instanceof Error ? e.message : "failed to load round");
    } finally {
      if (currentTier.current === forTier) setLoading(false);
    }
  }, [tier]);

  useEffect(() => {
    // New lane: never show the previous lane's round while the fresh read is in
    // flight (and never let it be deposited into).
    setLoading(true);
    setError(null);
    void refresh();
    const poll = setInterval(() => void refresh(), pollMs);
    const onDeposit = () => void refresh();
    window.addEventListener("roulette:deposit", onDeposit);
    return () => {
      clearInterval(poll);
      window.removeEventListener("roulette:deposit", onDeposit);
    };
  }, [refresh, pollMs]);

  // Only ever expose the current lane's data; anything else reads as loading.
  const ready = state.tier === tier;
  return {
    round: ready ? state.round : null,
    entries: ready ? state.entries : [],
    loading: ready ? loading : true,
    error: ready ? error : null,
    refresh,
  };
}
