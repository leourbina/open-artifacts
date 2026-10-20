import { defineConfig } from "vitest/config";

// Real-browser checks (Playwright Chromium and WebKit) against the built
// site. Kept out of `pnpm test`, which has no browsers in CI; run with
// `pnpm --filter @oa/landing test:browser` (the CI e2e job does).
export default defineConfig({
  test: { include: ["test-browser/**/*.test.ts"], testTimeout: 60_000 },
});
