import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "SolRoll — On-Chain Roulette on Solana",
  description:
    "SolRoll is provably fair, on-chain roulette on Solana devnet. Deposits go into a program-owned escrow; the winner is deterministically selected and independently verifiable.",
  openGraph: {
    title: "SolRoll — On-Chain Roulette on Solana",
    description:
      "Provably fair, on-chain roulette on Solana devnet. Program-owned escrow, deterministic winner selection, independently verifiable.",
    type: "website",
  },
  twitter: {
    title: "SolRoll — On-Chain Roulette on Solana",
    description:
      "Provably fair, on-chain roulette on Solana devnet. Program-owned escrow, deterministic winner selection, independently verifiable.",
  },
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-felt-950 text-ivory antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
