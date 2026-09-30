"use client";

/**
 * Wallet error vocabulary — one place that knows how Solana wallet failures
 * look and what to tell the player.
 *
 * WHY THIS EXISTS
 * ---------------
 * wallet-adapter reports every failure through `WalletProvider.onError`,
 * which was wired to `console.error` only: the player saw the wallet modal
 * close and nothing else. Signing failures arrived as deeply nested errors
 * (`WalletSendTransactionError` → `SendTransactionError` → the real cause)
 * whose message text is developer vocabulary ("Blockhash not found"), and the
 * classic wrong-cluster case — wallet on MAINNET while the app builds a
 * DEVNET transaction — surfaced as a misleading "Blockhash not found" even
 * though the real problem is the network. This module turns all of that into:
 *
 *   1. `classifyWalletError`  — stable machine-readable reasons, unwrapping
 *      the full `cause` chain so the real error text is always inspected;
 *   2. `walletErrorMessage`   — one honest, actionable sentence per reason;
 *   3. `probeWalletClusterMismatch` — reads the provider's `cluster` /
 *      `chainId` / endpoint BEFORE any transaction is built and refuses the
 *      mismatch with an explanation instead of a cryptic RPC error;
 *   4. `reportWalletError` / `useWalletError` — a module-level pubsub so
 *      `WalletProvider.onError` reaches the UI (`WalletErrorBanner`) without
 *      restructuring the provider tree.
 *
 * SECURITY: operates on error objects and public config only. Never logs or
 * displays key material — the browser never has any (see lib/txLog.ts).
 */

import { useEffect, useState, useSyncExternalStore } from "react";

export type WalletFailureReason =
  | "rejected_by_user"
  | "wrong_cluster"
  | "blockhash_expired"
  | "insufficient_devnet_balance"
  | "wallet_disconnected"
  | "wallet_not_found"
  | "rpc_unreachable"
  | "unknown_error";

export const APP_CLUSTER = "devnet";

/**
 * Flatten an error (and its whole `cause` chain — wallet-adapter wraps
 * everything) into one lowercase string for pattern matching.
 */
function errorChainText(err: unknown, depth = 0): string {
  if (depth > 5 || err === null || err === undefined) return "";
  if (typeof err === "string") return err;
  let text = "";
  if (err instanceof Error) text += ` ${err.message}`;
  else if (typeof (err as { message?: unknown })?.message === "string") {
    text += ` ${(err as { message: string }).message}`;
  }
  // Numeric codes (WalletError.code, EIP-1193-style 4001 rejections, ...).
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "number" || typeof code === "string") text += ` code=${code}`;
  const cause = (err as { cause?: unknown })?.cause;
  if (cause !== undefined) text += ` ${errorChainText(cause, depth + 1)}`;
  return text.toLowerCase();
}

/**
 * Map any thrown value to a stable reason. Inspects the FULL cause chain, so
 * an adapter wrapper never hides the real failure.
 */
export function classifyWalletError(err: unknown): WalletFailureReason {
  const text = errorChainText(err);
  if (text === "") return "unknown_error";
  // User refusal first: code 4001 or any explicit reject wording.
  if (/code=4001/.test(text) || /user rejected|user denied|rejected the request|request was rejected|cancelled by the user|wallet_sign.*cancel/.test(text)) {
    return "rejected_by_user";
  }
  if (/blockhash not found|block height exceeded|blockhash has expired|has expired and was no longer valid|expired/.test(text)) {
    return "blockhash_expired";
  }
  if (/attempt to debit an account but found no record|insufficient lamports|insufficient funds/.test(text)) {
    return "insufficient_devnet_balance";
  }
  if (/wrong network|unsupported chain|cluster mismatch|expected cluster|wallet.*cluster.*devnet|devnet.*cluster.*mismatch/.test(text)) {
    return "wrong_cluster";
  }
  if (/wallet.*(not connected|is disconnected|connection was closed)|walletnotconnectederror|not authorized to use|unauthorized/.test(text)) {
    return "wallet_disconnected";
  }
  if (/(not registered|is not installed|could not be found|wallet not found|no wallet found)/.test(text)) {
    return "wallet_not_found";
  }
  if (/fetch failed|failed to fetch|networkerror|network error|429|503|rate limit|overload/.test(text)) {
    return "rpc_unreachable";
  }
  return "unknown_error";
}

/**
 * One honest, actionable sentence per failure reason. Every message names
 * devnet where the network matters, so a player is never left guessing which
 * cluster they should be on.
 */
const REASON_MESSAGES: Record<WalletFailureReason, string> = {
  rejected_by_user: "The request was rejected in your wallet — nothing was sent. Retry when you're ready and approve the transaction to continue.",
  wrong_cluster: "Your wallet is on a different Solana network than this app. Switch your wallet to Devnet and try again — this site never transacts on mainnet.",
  blockhash_expired: "The transaction didn't land before its blockhash expired. This happens on a slow network or with the wallet on the wrong cluster — confirm your wallet is on Devnet and retry.",
  insufficient_devnet_balance: "Your wallet doesn't hold enough devnet SOL to cover the bet plus the network fee. Use the faucet in the devnet banner above and retry.",
  wallet_disconnected: "Your wallet was disconnected mid-request. Reconnect from the wallet button at the top and try again.",
  wallet_not_found: "That wallet isn't available in this browser. Install it (or pick another wallet) from the wallet menu.",
  rpc_unreachable: "The Solana devnet RPC didn't respond. This is usually temporary — wait a moment and retry.",
  unknown_error: "Something went wrong while talking to your wallet. Check your wallet app, make sure it's on Devnet, and try again.",
};

export function walletErrorMessage(reason: WalletFailureReason): string {
  return REASON_MESSAGES[reason] ?? REASON_MESSAGES.unknown_error;
}

/**
 * Build a user-facing message for a thrown deposit/wallet error: known
 * "rejected" errors carry their own (already friendly) message; everything
 * else is classified and mapped.
 */
export function friendlyWalletError(err: unknown): string {
  return walletErrorMessage(classifyWalletError(err));
}

// ---------------------------------------------------------------------------
// wallet cluster detection (wrong-network pre-check)
// ---------------------------------------------------------------------------

interface ProviderProbe {
  cluster?: unknown;
  chainId?: unknown;
  rpcUrl?: unknown;
}

/**
 * Best-effort read of the injected provider's active cluster. Phantom and
 * Solflare expose `cluster` ("mainnet-beta" | "devnet" | "testnet"); the
 * MultiChain spec exposes `chainId` ("solana:<cluster>" or an endpoint URL).
 * Returns a raw display string, or null when the wallet does not say.
 */
export function detectWalletCluster(provider: unknown): string | null {
  if (provider === null || typeof provider !== "object") return null;
  const p = provider as ProviderProbe;
  if (typeof p.cluster === "string" && p.cluster.trim() !== "") return p.cluster.trim();
  if (typeof p.chainId === "string" && p.chainId.trim() !== "") return p.chainId.trim();
  if (typeof p.rpcUrl === "string" && p.rpcUrl.trim() !== "") return p.rpcUrl.trim();
  return null;
}

function normaliseCluster(raw: string): "mainnet" | "devnet" | "testnet" | null {
  const s = raw.toLowerCase();
  if (s.includes("mainnet")) return "mainnet";
  if (s.includes("devnet")) return "devnet";
  if (s.includes("testnet")) return "testnet";
  return null;
}

export interface ClusterProbe {
  /** Raw cluster/chainId/endpoint string the wallet reports, or null. */
  walletCluster: string | null;
  /** True only when the wallet reports a KNOWN cluster different from the app's. */
  mismatch: boolean;
}

/**
 * Compare the wallet's active cluster with the app's (`devnet`). A wallet
 * that does not advertise its cluster yields mismatch:false with
 * walletCluster:null — the app still verifies the network server-side after
 * every signature, so this probe can only block early, never approve wrongly.
 */
export function probeWalletClusterMismatch(
  provider: unknown,
  appCluster: string = APP_CLUSTER
): ClusterProbe {
  const raw = detectWalletCluster(provider);
  if (!raw) return { walletCluster: null, mismatch: false };
  const wallet = normaliseCluster(raw);
  const app = normaliseCluster(appCluster);
  if (!wallet || !app) return { walletCluster: raw, mismatch: false };
  return { walletCluster: raw, mismatch: wallet !== app };
}

// ---------------------------------------------------------------------------
// global wallet error surface (WalletProvider.onError → UI)
// ---------------------------------------------------------------------------

interface WalletErrorState {
  message: string;
  at: number;
}

let lastWalletError: WalletErrorState | null = null;
const walletErrorListeners = new Set<() => void>();

/** Called from `WalletProvider.onError` — anything the adapter reports. */
export function reportWalletError(err: unknown): void {
  const message = friendlyWalletError(err);
  lastWalletError = { message, at: Date.now() };
  for (const l of walletErrorListeners) {
    try {
      l();
    } catch {
      /* a broken listener must never break the others */
    }
  }
}

export function clearWalletError(): void {
  if (lastWalletError === null) return;
  lastWalletError = null;
  for (const l of walletErrorListeners) l();
}

/** Subscribe to wallet-error changes; used by useWalletError and tests. */
export function subscribeWalletError(listener: () => void): () => void {
  walletErrorListeners.add(listener);
  return () => walletErrorListeners.delete(listener);
}

/** Snapshot accessor — also usable from non-React code and tests. */
export function getWalletError(): WalletErrorState | null {
  return lastWalletError;
}

/** Latest adapter error as a user-facing message, or null. */
export function useWalletError(): WalletErrorState | null {
  return useSyncExternalStore(
    subscribeWalletError,
    getWalletError,
    () => null
  );
}

/**
 * Notice when the connected wallet goes away (tab killed the provider,
 * extension reload, manual lock). wallet-adapter swaps `wallet` to null for
 * voluntary disconnects too, so the banner is factual ("disconnected") and
 * auto-clears after a few seconds; reconnecting clears it immediately.
 * The remembering logic lives in the banner component (where the connected
 * name is already in scope), this hook only holds the flag.
 */
export function useTransientNotice(): [string | null, (msg: string | null) => void] {
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6_000);
    return () => clearTimeout(t);
  }, [notice]);
  return [notice, setNotice];
}
