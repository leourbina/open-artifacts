import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index.ts";

const KEY = "k".repeat(40);

const ROW = {
  id: "inst1",
  app_host: "a.example.com",
  content_host: "c.example.com",
  state: "active",
  test_hooks: 1,
  owner_email: "o@example.com",
  inputs_hash: "h",
  d1_id: "d1",
  broker_kid: "kid",
};

function makeEnv(over: Partial<Env> = {}, rows: object[] = [ROW]) {
  const sqls: string[] = [];
  const PLATFORM_DB = {
    prepare(sql: string) {
      sqls.push(sql);
      return {
        bind() {
          return this;
        },
        async all() {
          return { results: rows };
        },
      };
    },
  };
  return {
    env: { PLATFORM_DB, INVENTORY_KEY: KEY, ...over } as unknown as Env,
    sqls,
  };
}

const req = (path = "/installs", init: RequestInit = {}, auth?: string) =>
  new Request(`https://x.test${path}`, {
    ...init,
    headers: auth === undefined ? {} : { authorization: auth },
  });

async function call(r: Request, env: Env) {
  return worker.fetch(r, env);
}

async function expect404(r: Request, env: Env) {
  const res = await call(r, env);
  expect(res.status).toBe(404);
  expect(await res.text()).toBe("Not found");
}

describe("auth", () => {
  it("wrong key -> 404", async () => {
    await expect404(
      req("/installs", {}, `Bearer ${"z".repeat(40)}`),
      makeEnv().env,
    );
  });
  it("missing header -> 404", async () => {
    await expect404(req(), makeEnv().env);
  });
  it("non-Bearer scheme -> 404", async () => {
    await expect404(req("/installs", {}, `Basic ${KEY}`), makeEnv().env);
    await expect404(req("/installs", {}, KEY), makeEnv().env);
  });
  it("missing or short INVENTORY_KEY fails closed", async () => {
    const short = "s".repeat(31);
    await expect404(
      req("/installs", {}, `Bearer ${short}`),
      makeEnv({ INVENTORY_KEY: short }).env,
    );
    await expect404(
      req("/installs", {}, "Bearer "),
      makeEnv({ INVENTORY_KEY: undefined }).env,
    );
    await expect404(
      req("/installs", {}, "Bearer undefined"),
      makeEnv({ INVENTORY_KEY: undefined }).env,
    );
  });
});

describe("routing", () => {
  it("other paths and methods -> 404", async () => {
    const { env } = makeEnv();
    await expect404(req("/installs", { method: "POST" }, `Bearer ${KEY}`), env);
    await expect404(req("/", {}, `Bearer ${KEY}`), env);
    await expect404(req("/installs/x", {}, `Bearer ${KEY}`), env);
  });
});

describe("response", () => {
  it("returns only the five mapped fields", async () => {
    const { env, sqls } = makeEnv();
    const res = await call(req("/installs", {}, `Bearer ${KEY}`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { installs: Record<string, unknown>[] };
    expect(Object.keys(body)).toEqual(["installs"]);
    expect(body.installs).toHaveLength(1);
    expect(Object.keys(body.installs[0]).sort()).toEqual(
      ["appHost", "contentHost", "id", "state", "testHooks"].sort(),
    );
    expect(body.installs[0]).toEqual({
      id: "inst1",
      appHost: "a.example.com",
      contentHost: "c.example.com",
      state: "active",
      testHooks: true,
    });
    expect(typeof body.installs[0].testHooks).toBe("boolean");
    expect(JSON.stringify(body)).not.toMatch(/o@example|inputs|d1|kid/);
    expect(sqls).toEqual([
      "SELECT id, app_host, content_host, state, test_hooks FROM installs ORDER BY id",
    ]);
  });
  it("testHooks false for 0", async () => {
    const { env } = makeEnv({}, [{ ...ROW, test_hooks: 0 }]);
    const res = await call(req("/installs", {}, `Bearer ${KEY}`), env);
    const body = (await res.json()) as { installs: { testHooks: boolean }[] };
    expect(body.installs[0].testHooks).toBe(false);
  });
});

describe("wrangler.jsonc", () => {
  it("has no binding except PLATFORM_DB", () => {
    const raw = readFileSync(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8",
    );
    const cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as Record<
      string,
      unknown
    >;
    expect(cfg.d1_databases).toEqual([
      expect.objectContaining({
        binding: "PLATFORM_DB",
        database_name: "oa-platform",
      }),
    ]);
    for (const k of [
      "kv_namespaces",
      "r2_buckets",
      "services",
      "durable_objects",
      "vars",
      "routes",
      "route",
      "triggers",
      "queues",
      "ai",
      "analytics_engine_datasets",
    ]) {
      expect(cfg, k).not.toHaveProperty(k);
    }
    expect(cfg.workers_dev).toBe(true);
    expect(cfg.preview_urls).toBe(false);
  });
});
