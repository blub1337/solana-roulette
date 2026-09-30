import { test, expect } from "@playwright/test";

// Smoke: the landing page renders the core round UI.
//
// The brand assertion tracks the product name shown in the hero (SOLROLL).
// It is scoped to the heading on purpose: the wordmark also appears in the
// document title and as the logo image's alt text, so a bare getByText would
// match several nodes and fail in strict mode.
test("home shows roulette UI and devnet banner", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "SOLROLL" })).toBeVisible();
  await expect(page.getByText("devnet only")).toBeVisible();
});

/**
 * The fee on the page must be the fee the API reports.
 *
 * Regression guard: the percentage used to be hardcoded in the markup (7.5 %
 * once, 2 % the next) while the runtime charged whatever the config said, so
 * the page could state a fee nobody was charged. The API value is the one the
 * runtime enforces (on-chain config in chain mode, PLATFORM_FEE_BPS in local
 * mode) and the page now renders it verbatim.
 *
 * Skipped when the API is not reachable: without it the page deliberately
 * shows a placeholder rather than a guessed number, and that is the correct
 * behaviour, not a failure.
 */
test("home shows the fee the API reports", async ({ page, request }) => {
  const api = await request.get("/api/config");
  test.skip(!api.ok(), "API not reachable — the page falls back to a placeholder");
  const { feeBps } = (await api.json()) as { feeBps: number };
  const feePercent = `${(feeBps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
  const winnerPercent = `${((10_000 - feeBps) / 100).toLocaleString("en-US", {
    maximumFractionDigits: 2,
  })}%`;

  await page.goto("/");
  await expect(page.getByText(`${feePercent} platform fee`)).toBeVisible();
  await expect(page.getByText(`${winnerPercent} winner`)).toBeVisible();
  await expect(page.getByText(`${feePercent} fee`, { exact: true })).toBeVisible();
});
