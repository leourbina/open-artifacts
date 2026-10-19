import { defineConfig } from "vitest/config";

// Real-browser checks (Playwright Chromium). Kept out of `pnpm test`, which
// has no browsers in CI; run with `pnpm --filter @oa/ui test:browser`.
export default defineConfig({
  test: { include: ["test-browser/**/*.test.{ts,tsx}"], testTimeout: 60_000 },
});
