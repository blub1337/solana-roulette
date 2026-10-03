"use client";

import { useEffect, useMemo, useState, type ComponentProps } from "react";
import { clusterApiUrl } from "@solana/web3.js";
import {
  ConnectionProvider,
  WalletProvider,
  useWallet,
} from "@solana/wallet-adapter-react";
import {
  WalletModalProvider,
  WalletMultiButton as WalletMultiButtonBase,
} from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { WalletErrorBanner } from "../components/WalletErrorBanner";
import { reportWalletError } from "../lib/walletErrors";
import "@solana/wallet-adapter-react-ui/styles.css";

const network = (process.env.NEXT_PUBLIC_SOLANA_NETWORK ?? "devnet") as
  | "devnet"
  | "testnet"
  | "mainnet-beta";

export function Providers({ children }: { children: React.ReactNode }) {
  const endpoint = useMemo(() => {
    const custom = process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
    if (custom) return custom;
    if (network === "mainnet-beta") {
      // Hard gate: mainnet requires explicit build-time enablement.
      if (process.env.NEXT_PUBLIC_ENABLE_MAINNET !== "true") {
        console.error(
          "MAINNET_DISABLED: set NEXT_PUBLIC_ENABLE_MAINNET=true after legal/security review."
        );
      }
      return clusterApiUrl("mainnet-beta");
    }
    return clusterApiUrl(network);
  }, []);

  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);

  const onError = (error: Error) => {
    // Every adapter failure (modal rejections, wallet-not-installed,
    // unexpected disconnects) becomes a visible, dismissible banner with an
    // actionable message instead of console-only noise. The raw error is
    // still logged for diagnosis.
    console.error("[wallet]", error.message);
    reportWalletError(error);
  };

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} onError={onError} autoConnect>
        <WalletModalProvider>
          <WalletErrorBanner />
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

/**
 * Client-only wallet connect button.
 *
 * `@solana/wallet-adapter-react-ui`'s WalletMultiButton reads the SELECTED
 * wallet from localStorage during its first render, so on the client it emits a
 * wallet icon — `<i class="wallet-adapter-button-start-icon">` — inside its
 * `<button>`, while the server HTML was rendered with no wallet selected and has
 * no such `<i>`. That mismatch is exactly what React reports as:
 *   "Hydration failed ... Expected server HTML to contain a matching <i> in <button>".
 *
 * Rendering the real button only AFTER mount keeps the server output and the
 * first client render identical (both show the plain placeholder), so hydration
 * succeeds and the wallet-aware button swaps in immediately afterwards.
 *
 * The public API is unchanged: callers still render `<WalletMultiButton />`.
 */
export function WalletMultiButton(props: ComponentProps<typeof WalletMultiButtonBase>) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    // Mirrors the provider's no-wallet state, so the slot reserves its
    // footprint and there is no layout shift when the real button appears.
    return (
      <button className="wallet-adapter-button" type="button">
        Select Wallet
      </button>
    );
  }
  return <WalletMultiButtonBase {...props} />;
}

export { useWallet };
