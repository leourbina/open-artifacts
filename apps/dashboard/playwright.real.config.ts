// The dashboard against the real server (`wrangler dev`, see e2e/real/fixtures.ts).
// The mocked suite is playwright.config.ts.
import { defineConfig, devices } from "@playwright/test";
import { APP } from "./e2e/real/fixtures";

export default defineConfig({
  testDir: "e2e/real",
  globalSetup: "./e2e/real/global-setup.ts",
  timeout: 60_000,
  globalTimeout: 10 * 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: APP, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
