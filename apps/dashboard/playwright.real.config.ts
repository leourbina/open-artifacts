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
  // Stopgap while the agent-journey spec shares server state with parallel
  // files (#185): one CI retry, still reported as "flaky" in the list output.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: APP, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
