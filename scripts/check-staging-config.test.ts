import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const raw = readFileSync(
  join(root, "apps/server/wrangler.staging.jsonc"),
  "utf8",
);
// Strip // and /* */ comments outside strings.
const strip = (s: string) =>
  s.replace(
    /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (_m, str) => str ?? "",
  );
// biome-ignore lint/suspicious/noExplicitAny: untyped wrangler config
const cfg: any = JSON.parse(strip(raw));
const env = cfg.env.staging;

describe("wrangler.staging.jsonc env.staging", () => {
  it("keeps name and custom domains", () => {
    expect(env.name).toBe("open-artifacts-staging");
    expect(env.routes.map((r: { pattern: string }) => r.pattern)).toEqual([
      "staging.open-artifacts.com",
      "staging-content.open-artifacts.com",
    ]);
  });
  it("enables nodejs_compat", () => {
    expect(env.compatibility_flags ?? cfg.compatibility_flags).toContain(
      "nodejs_compat",
    );
  });
  it("binds D1 DB, R2 FILES, KV OAUTH_KV", () => {
    expect(env.d1_databases[0].binding).toBe("DB");
    expect(env.d1_databases[0].database_id).toBe(
      "5155e2d4-d9bf-4900-b4ab-1febd480377a",
    );
    expect(env.r2_buckets[0]).toMatchObject({
      binding: "FILES",
      bucket_name: "open-artifacts-staging",
    });
    expect(env.kv_namespaces[0]).toMatchObject({
      binding: "OAUTH_KV",
      id: "886a49c875024e8ab5262928d75f85b7",
    });
  });
  it("binds the ArtifactRuntime durable object with sqlite migration", () => {
    expect(env.durable_objects.bindings).toEqual([
      { name: "ARTIFACT_RUNTIME", class_name: "ArtifactRuntime" },
    ]);
    expect(env.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["ArtifactRuntime"] },
    ]);
  });
  it("binds ASSETS with run_worker_first true", () => {
    expect(env.assets).toEqual({
      binding: "ASSETS",
      directory: "../dashboard/dist",
      not_found_handling: "single-page-application",
      run_worker_first: true,
    });
  });
  it("binds RL_ANON ratelimit", () => {
    expect(env.ratelimits).toEqual([
      {
        name: "RL_ANON",
        namespace_id: "1001",
        simple: { limit: 30, period: 60 },
      },
    ]);
  });
  it("has the daily cron", () => {
    expect(env.triggers.crons).toEqual(["17 3 * * *"]);
  });
  it("has the expected vars and no secrets", () => {
    const { ACCESS_CLIENT_ID, ...vars } = env.vars;
    expect(vars).toEqual({
      ENVIRONMENT: "production",
      APP_HOST: "staging.open-artifacts.com",
      CONTENT_HOST: "staging-content.open-artifacts.com",
      OWNER_EMAIL: "me@leourbina.com",
      ACCESS_TEAM_DOMAIN: "leourbina.cloudflareaccess.com",
    });
    expect(ACCESS_CLIENT_ID).toMatch(/^[0-9a-f]{64}$/);
  });
});
