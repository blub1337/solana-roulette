"use client";

import { useEffect, useState } from "react";
import { API_BASE } from "../lib/apiBase";
import { feeTermsFrom, type FeeTerms } from "../lib/fees";

const API = API_BASE; // production-safe API base (same-origin in dev)

export interface FeeInfo extends FeeTerms {
  /** Where the API read the enforced fee from (runtime ledger / on-chain config). */
  source: string;
}

interface ConfigResponse {
  feeBps: number;
  feeSource?: string;
}

/**
 * The fee the platform actually charges, as reported by `/api/config`.
 *
 * `null` until the first successful response: pages render a placeholder
 * instead of a guessed percentage, because a wrong fee figure on a money page
 * is worse than a dash for a few milliseconds.
 */
export function useFeeTerms() {
  const [fee, setFee] = useState<FeeInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`${API}/api/config`, { cache: "no-store" });
        if (!res.ok) throw new Error(`API ${res.status}`);
        const json = (await res.json()) as ConfigResponse;
        if (cancelled || !Number.isFinite(json.feeBps)) return;
        setFee({ ...feeTermsFrom(json.feeBps), source: json.feeSource ?? "" });
      } catch {
        /* keep the last known value; the placeholder stays if there never was one */
      }
    }
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return fee;
}
