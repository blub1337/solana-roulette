"use client";

import { useMemo } from "react";
import { clusterApiUrl } from "@solana/web3.js";
import {
  ConnectionProvider,
  WalletProvider,
  useWallet,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
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
    console.error("[wallet]", error.message);
  };

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} onError={onError} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

export { WalletMultiButton, useWallet };
