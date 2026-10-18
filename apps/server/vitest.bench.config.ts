import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * CPU-budget bench (`pnpm bench`): Node, not the workerd pool, because
 * workerd exposes no per-request CPU clock locally. See scripts/bench.ts.
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
    include: ["test/cpu-budget/**/*.bench.ts"],
    environment: "node",
    testTimeout: 600_000,
    hookTimeout: 600_000,
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
