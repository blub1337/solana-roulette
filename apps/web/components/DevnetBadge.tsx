"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { clientTxLog } from "../lib/txLog";

/**
 * 🧪 SOLANA DEVNET — always visible, never decorative.
 *
 * Shows the live cluster, the escrow that receives deposits, the escrow's real
 * on-chain balance and a faucet button for players who need devnet SOL.
 */
export function DevnetBadge() {
  const { publicKey, connected } = useWallet();
  const [custody, setCustody] = useState<CustodyInfo | null>(null);
  const [airdrop, setAirdrop] = useState<{ busy: boolean; message: string | null }>({
    busy: false,
    message: null,
  });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/custody", { cache: "no-store" });
      if (!res.ok) return;
      setCustody((await res.json()) as CustodyInfo);
    } catch {
      /* the API may be restarting; the badge degrades to static text */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  const requestAirdrop = useCallback(async () => {
    if (!publicKey) return;
    setAirdrop({ busy: true, message: null });
    const wallet = publicKey.toBase58();
    clientTxLog.info("airdrop.requested", { wallet, network: "devnet" });
    try {
      const res = await fetch("/api/devnet/airdrop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet }),
      });
      const json = (await res.json()) as { ok: boolean; signature: string | null; error: string | null };
      if (json.ok) {
        clientTxLog.info("airdrop.confirmed", { wallet, network: "devnet", signature: json.signature });
        setAirdrop({ busy: false, message: "1 devnet SOL requested — check your wallet." });
        setTimeout(load, 4_000);
      } else {
        clientTxLog.warn("airdrop.failed", { wallet, network: "devnet", error: json.error });
        setAirdrop({ busy: false, message: json.error ?? "Faucet rate limited. Use the link below." });
      }
    } catch (e) {
      clientTxLog.warn("airdrop.failed", {
        wallet,
        network: "devnet",
        error: e instanceof Error ? e.message : String(e),
      });
      setAirdrop({ busy: false, message: "Faucet unreachable. Use the link below." });
    }
  }, [publicKey, load]);

  return (
    <div
      data-testid="devnet-badge"
      className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-teal-500/40 bg-teal-500/10 px-4 py-2.5 text-xs text-teal-100"
    >
      <span className="font-semibold uppercase tracking-widest">🧪 Solana Devnet</span>
      <span className="text-teal-200/70">
        No mainnet. Every deposit and payout is a real devnet transaction.
      </span>
      {custody?.escrow && (
        <a
          href={`https://explorer.solana.com/address/${custody.escrow}?cluster=devnet`}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-teal-200/80 underline decoration-dotted hover:text-teal-100"
        >
          escrow {custody.escrow.slice(0, 4)}…{custody.escrow.slice(-4)}
          {custody.escrowBalanceLamports ? ` · ${(Number(custody.escrowBalanceLamports) / 1e9).toFixed(3)} ◎` : ""}
        </a>
      )}
      {!custody?.custodyReady && custody && (
        <span className="text-amber-200">
          ⚠ Deposits are paused: {custody.custodyReason}. Add <code>OPERATOR_KEYPAIR</code> in
          Settings → Environment and fund the escrow with devnet SOL to enable real transfers.
        </span>
      )}
      <span className="ml-auto flex items-center gap-3">
        {connected && (
          <button
            type="button"
            onClick={requestAirdrop}
            disabled={airdrop.busy}
            className="rounded-lg border border-teal-400/50 px-2.5 py-1 font-semibold text-teal-100 transition hover:bg-teal-400/20 disabled:opacity-50"
          >
            {airdrop.busy ? "Requesting…" : "Get 1 devnet SOL"}
          </button>
        )}
        <a
          href="https://faucet.solana.com"
          target="_blank"
          rel="noreferrer"
          className="text-teal-200/80 underline decoration-dotted hover:text-teal-100"
        >
          Faucet ↗
        </a>
      </span>
      {airdrop.message && <span className="w-full text-teal-200/80">{airdrop.message}</span>}
    </div>
  );
}

interface CustodyInfo {
  cluster: string;
  escrow: string | null;
  escrowBalanceLamports?: string;
  feeWallet: string;
  custodyReady: boolean;
  custodyReason: string;
}
