import { defineConfig } from "vitest/config";

// Smoke tests hit live staging over the network, so they run in plain node, not workerd.
// A just-deployed Worker can be slow on its first requests (cold isolates, D1 and DO
// placement), so the suite warms it up first and allows network-scale timeouts.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/smoke/**/*.ts"],
    globalSetup: ["test/smoke-setup/warmup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    retry: 1,
  },
});
