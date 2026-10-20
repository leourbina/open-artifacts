import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(
  path.join(import.meta.dirname, "migrations"),
);

/**
 * Wall-clock CPU budgets (`pnpm test:cpu`, its own CI step): one file at a
 * time, one worker, so no other test competes for the CPU being measured.
 * Absolute bounds are reported, and asserted only with CPU_STRICT=1
 * (`pnpm test:cpu:strict`; see budget() in test/cpu-time.ts).
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          CPU_STRICT: process.env.CPU_STRICT === "1" ? "1" : "0",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.cpu.test.ts"],
    setupFiles: ["./test/setup.ts"],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
