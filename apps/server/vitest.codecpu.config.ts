import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Code CPU per route (`pnpm test:cpu`, after the workerd wall-clock files):
 * Node, like vitest.bench.config.ts (workerd has no per-request CPU clock
 * locally; see scripts/bench.ts), serial, with --expose-gc.
 */
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": here("./scripts/bench-stubs/cloudflare-workers.ts"),
      "cloudflare:email": here("./scripts/bench-stubs/cloudflare-email.ts"),
      "@oa/shared": here("../../packages/shared/src/index.ts"),
    },
  },
  test: {
    include: ["test/code-cpu/**/*.test.ts"],
    environment: "node",
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    pool: "forks",
    execArgv: ["--expose-gc"],
    server: {
      deps: {
        inline: [/agents/, /workers-oauth-provider/, /@modelcontextprotocol/],
      },
    },
  },
});
