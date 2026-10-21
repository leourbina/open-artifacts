import { defineConfig } from "vitest/config";

/**
 * The sign-in negative catalog live against two real installs (P5 runs it on
 * stg-a and stg-b every release): `pnpm xt:live` with XT_A, XT_B (origins),
 * XT_A_KEY, XT_B_KEY (TEST_HOOK_KEYs) and, where Turnstile is on, XT_A_TURNSTILE
 * and XT_B_TURNSTILE (a token each install's test secret accepts). Plain Node:
 * real fetch, no worker pool.
 */
export default defineConfig({
  test: {
    include: ["test/xt/*.xt.ts"],
    testTimeout: 30_000,
  },
});
