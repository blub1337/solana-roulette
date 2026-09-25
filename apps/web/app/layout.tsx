import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Solana Roulette — DEVNET",
  description:
    "Provably fair, on-chain roulette on Solana devnet. Deposits go into a program-owned escrow; the winner is deterministically selected and independently verifiable.",
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
