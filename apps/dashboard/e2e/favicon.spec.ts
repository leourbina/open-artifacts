import { expect, test } from "@playwright/test";

test("document head declares the icons and theme color", async ({ page }) => {
  await page.goto("/");
  const head = page.locator("head");
  await expect(
    head.locator('link[rel="icon"][href="/favicon.svg"][type="image/svg+xml"]'),
  ).toHaveCount(1);
  await expect(
    head.locator('link[rel="icon"][href="/favicon.ico"][sizes="32x32"]'),
  ).toHaveCount(1);
  await expect(
    head.locator('link[rel="apple-touch-icon"][href="/apple-touch-icon.png"]'),
  ).toHaveCount(1);
  // Neutral browser bar per theme: Studio keeps blue for state.
  await expect(
    head.locator(
      'meta[name="theme-color"][content="#EEF0F3"][media="(prefers-color-scheme: light)"]',
    ),
  ).toHaveCount(1);
  await expect(
    head.locator(
      'meta[name="theme-color"][content="#131518"][media="(prefers-color-scheme: dark)"]',
    ),
  ).toHaveCount(1);
});
