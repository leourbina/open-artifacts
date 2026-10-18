import { defineConfig } from "vitest/config";

// Smoke tests hit live staging over the network, so they run in plain node, not workerd.
export default defineConfig({
  test: { environment: "node", include: ["test/smoke/**/*.ts"] },
});
