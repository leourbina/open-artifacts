import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(
  path.join(import.meta.dirname, "migrations"),
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    // Wall-clock budgets run alone (vitest.cpu.config.ts), never under suite load.
    exclude: ["test/**/*.cpu.test.ts", "**/node_modules/**"],
    setupFiles: ["./test/setup.ts"],
  },
});
