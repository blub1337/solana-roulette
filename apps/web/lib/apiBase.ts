/**
 * Single source of the API base for every browser fetch in the web app
 * (useDeposit, usePools, useRoundState, useRuntime, useSse, adminClient).
 *
 * `process.env.NEXT_PUBLIC_API_URL` is inlined at BUILD time by Next.js, so a
 * bad value (e.g. http://127.0.0.1:3000) gets baked into the client bundle and
 * breaks the deployed frontend exactly like a broken server proxy does. This
 * module therefore refuses loopback targets in production and falls back to
 * the deployed Render API. Dev keeps same-origin ("" → next.config.mjs
 * rewrite → local API on :4000, matching scripts/start-preview.sh).
 *
 * Architecture note: this changes only WHERE requests go — the wallet/deposit
 * flow, the roulette logic and the custody/payout system are untouched.
 */
const RENDER_API_URL = "https://solana-roulette-api-gd7k.onrender.com";

function resolveApiBase(): string {
  const isProd = process.env.NODE_ENV === "production";
  const raw = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (raw) {
    try {
      const { hostname } = new URL(raw);
      const loopback =
        hostname === "127.0.0.1" ||
        hostname === "localhost" ||
        hostname === "::1" ||
        hostname === "[::1]";
      if (!loopback) return raw.replace(/\/$/, "");
      if (isProd) {
        console.warn(
          `[api-base] NEXT_PUBLIC_API_URL=${raw} is a loopback address in production — ` +
            `using ${RENDER_API_URL} instead.`
        );
        return RENDER_API_URL;
      }
      return ""; // dev: same-origin proxy to the local API
    } catch {
      /* unparsable — fall through to defaults */
    }
  }
  // Production default: the deployed Render API (CORS is enabled server-side).
  // Development default: same-origin /api/* → next.config.mjs rewrite.
  return isProd ? RENDER_API_URL : "";
}

export const API_BASE = resolveApiBase();
