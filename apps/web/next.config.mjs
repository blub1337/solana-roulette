/** @type {import('next').NextConfig} */

/**
 * API target for the /api/* reverse proxy (the browser always calls
 * same-origin /api/*; this decides where those requests are forwarded).
 *
 * PRODUCTION must never depend on a local API process: a loopback target
 * (127.0.0.1, localhost, ::1) inside the deployed frontend refers to the
 * frontend container itself, where no API runs — the classic cause of
 * `ECONNREFUSED 127.0.0.1:3000`. Loopback targets are therefore refused when
 * NODE_ENV=production and the deployed Render API is used instead.
 *
 * Precedence:
 *   1. API_INTERNAL_URL    — explicit operator override (must be non-loopback
 *                            in production; a loopback value there is a
 *                            misconfiguration, not a working private network)
 *   2. NEXT_PUBLIC_API_URL — public API base (the same URL the browser hooks
 *                            already receive as a build-time constant)
 *   3. production default  — the deployed Render API
 *   4. dev default         — http://127.0.0.1:4000 (npm run dev:api)
 *
 * The dev/preview single-origin setup (scripts/start-preview.sh) is unchanged:
 * it starts the API on the public port and passes API_INTERNAL_URL explicitly,
 * which keeps working exactly as before.
 */
const RENDER_API_URL = "https://solana-roulette-api-gd7k.onrender.com";
const DEV_DEFAULT = "http://127.0.0.1:4000";

const isLoopback = (url) => {
  try {
    const { hostname } = new URL(url);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return true; // unparsable target: treat as unsafe
  }
};

function resolveApiTarget() {
  const isProd = process.env.NODE_ENV === "production";
  const override = process.env.API_INTERNAL_URL?.trim();
  const publicUrl = process.env.NEXT_PUBLIC_API_URL?.trim();

  if (override) {
    if (isProd && isLoopback(override)) {
      console.warn(
        `[next-config] API_INTERNAL_URL=${override} is a loopback address in production — ` +
          `there is no API process inside the frontend container. Using ${RENDER_API_URL} instead.`
      );
    } else {
      return override;
    }
  }
  if (publicUrl && !isLoopback(publicUrl)) return publicUrl.replace(/\/$/, "");
  if (isProd) return RENDER_API_URL;
  return DEV_DEFAULT;
}

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@solana-roulette/types",
    "@solana-roulette/config",
    "@solana-roulette/sdk",
    "@solana-roulette/verification",
  ],
  eslint: { ignoreDuringBuilds: true },
  webpack: (config) => {
    // Workspace packages use NodeNext-style "./x.js" imports; map them so
    // webpack resolves the underlying .ts sources (packages ship TS directly).
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    return config;
  },
  async rewrites() {
    // Proxy API calls: production → deployed Render API, dev/preview → local.
    const apiInternal = resolveApiTarget();
    console.log(`[next-config] /api/* proxy target: ${apiInternal} (NODE_ENV=${process.env.NODE_ENV ?? "unset"})`);
    return [{ source: "/api/:path*", destination: `${apiInternal}/api/:path*` }];
  },
};

export default nextConfig;
