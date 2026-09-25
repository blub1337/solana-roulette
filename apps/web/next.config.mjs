/** @type {import('next').NextConfig} */
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
    // Proxy API calls to the local API server (preview/dev single-port setup).
    const apiInternal = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000";
    return [{ source: "/api/:path*", destination: `${apiInternal}/api/:path*` }];
  },
};

export default nextConfig;
