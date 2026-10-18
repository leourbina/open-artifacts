import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { beforeAll } from "vitest";

beforeAll(async () => {
  const e = env as unknown as {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  };
  await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
});
