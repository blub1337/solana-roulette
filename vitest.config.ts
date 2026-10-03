import { defineConfig } from "vitest/config";

export default defineConfig({
  // Automatic JSX runtime so the web component tests (apps/web/lib/*.test.tsx)
  // can server-render a component without a React-in-scope import.
  esbuild: { jsx: "automatic" },
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "apps/web/lib/*.test.ts",
      "apps/web/lib/*.test.tsx",
    ],
    environment: "node",
    testTimeout: 15000,
  },
});
