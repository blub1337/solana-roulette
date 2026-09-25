"use client";

import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? ""; // same-origin proxy

export type RuntimeMode = "chain" | "local";

export interface CustodyInfo {
  cluster: string;
  escrow: string | null;
  feeWallet: string;
  payoutSignerConfigured: boolean;
  custodyReady: boolean;
  custodyReason: string;
}

export interface RuntimeInfo {
  ok: boolean;
  network: string;
  mainnetEnabled: boolean;
  /** "chain" = deployed Anchor program. "local" = devnet ledger for rounds. */
  mode: RuntimeMode;
  /** True when real devnet SOL moves for deposits and payouts. */
  realFunds: boolean;
  custody?: CustodyInfo;
  backendReason?: string;
  programId?: string;
  platformFeeWallet?: string | null;
}

/**
 * Which runtime the API is serving. The UI must never imply that lamports are
 * real unless the chain-backed custody layer is actually configured.
 */
export function useRuntime() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`${API}/api/health`, { cache: "no-store" });
        if (!res.ok) throw new Error(`API ${res.status}`);
        const json = (await res.json()) as RuntimeInfo;
        if (cancelled) return;
        setRuntime(json);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "API unreachable");
      }
    }
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return { runtime, error };
}
