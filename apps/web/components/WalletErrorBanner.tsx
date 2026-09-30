"use client";

import { useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  useWalletError,
  clearWalletError,
  useTransientNotice,
} from "../lib/walletErrors";

/**
 * Global wallet feedback surface.
 *
 * Renders TWO kinds of trouble that previously had no UI at all:
 *
 *  1. adapter errors — anything `WalletProvider.onError` reports (modal
 *     failures, installation problems, unexpected disconnect errors) shown as
 *     a dismissible banner with a friendly, actionable message;
 *  2. unexpected disconnects — the wallet disappearing without the user
 *     asking (extension reload, tab suspending the provider). wallet-adapter
 *     nulls `wallet` in BOTH cases, so while connected we remember the name
 *     and compare: a voluntary disconnect (publicKey already gone before the
 *     wallet swap, triggered by our own UI) is indistinguishable from an
 *     involuntary one here, which is why the notice is phrased factually.
 *
 * Rendered once, directly under the nav bar on every page via providers.tsx.
 */
export function WalletErrorBanner() {
  const error = useWalletError();
  const { wallet, publicKey } = useWallet();
  const [notice, setNotice] = useTransientNotice();

  // Remember the connected wallet so a swap-to-null can be reported.
  const lastName = useRef<string | null>(null);
  useEffect(() => {
    if (wallet) {
      lastName.current = wallet.adapter.name;
      return;
    }
    if (lastName.current) {
      const name = lastName.current;
      lastName.current = null;
      // Only report when the session really ended (no publicKey anymore).
      if (!publicKey) setNotice(`${name} disconnected.`);
    }
  }, [wallet, publicKey, setNotice]);

  if (!error && !notice) return null;

  return (
    <div className="mx-auto mb-4 max-w-6xl px-4" role="alert" data-testid="wallet-error-banner">
      {error && (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <span>⚠ {error.message}</span>
          <button
            type="button"
            onClick={clearWalletError}
            aria-label="Dismiss wallet error"
            className="shrink-0 rounded-lg border border-red-400/40 px-2 py-0.5 text-xs text-red-200 transition hover:bg-red-400/20"
          >
            Dismiss
          </button>
        </div>
      )}
      {notice && (
        <div className="mt-2 flex items-start justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <span>{notice} Reconnect from the wallet button to keep playing.</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss disconnect notice"
            className="shrink-0 rounded-lg border border-amber-400/40 px-2 py-0.5 text-xs text-amber-200 transition hover:bg-amber-400/20"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
