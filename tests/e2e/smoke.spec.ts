import { test, expect } from "@playwright/test";

// Smoke: the landing page renders the core round UI.
test("home shows roulette UI and devnet banner", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Solana Roulette")).toBeVisible();
  await expect(page.getByText("devnet only")).toBeVisible();
});
