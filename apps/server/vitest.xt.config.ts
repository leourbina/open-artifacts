import { defineConfig } from "vitest/config";

/**
 * Plain Node (real fetch, real fs; no worker pool).
 * - Always: the xt helper unit tests (test/xt/*.node.test.ts).
 * - With XT_A set: the sign-in negative catalog live against two installs
 *   (P5 runs it on stg-a and stg-b every release). Origins in XT_A and XT_B;
 *   credentials only from 0600 files: XT_A_KEY_FILE, XT_B_KEY_FILE and, where
 *   Turnstile is on, XT_TURNSTILE_FILE.
 */
export default defineConfig({
  test: {
    include: [
      "test/xt/*.node.test.ts",
      ...(process.env.XT_A ? ["test/xt/*.xt.ts"] : []),
    ],
    testTimeout: 30_000,
  },
});
