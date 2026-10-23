import { defineConfig } from "vitest/config";

/**
 * Plain Node (real fetch, real fs; no worker pool).
 * - Always: the xt helper unit tests (test/xt/*.node.test.ts).
 * - Only with XT_LIVE=1 (pnpm xt:live sets it): the sign-in negative catalog
 *   live against two staging installs (P5 runs it every release). See
 *   test/xt/live.xt.ts for its env and guards; credentials only from 0600
 *   files.
 */
export default defineConfig({
  test: {
    include: [
      "test/xt/*.node.test.ts",
      ...(process.env.XT_LIVE === "1" ? ["test/xt/*.xt.ts"] : []),
    ],
    testTimeout: 30_000,
  },
});
