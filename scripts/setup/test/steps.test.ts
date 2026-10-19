import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import {
  renderConfig,
  stripComments as stripJsonc,
} from "../src/steps/resources.ts";
import { ROOT, STATE } from "./fakes.ts";
import { filler, HOSTS, STAGING, world } from "./world.ts";

const statuses = (lines: string[]) =>
  lines.map((l) => JSON.parse(l)).map((j) => `${j.step}:${j.status}`);
const CONFIG = join(ROOT, "apps/server/wrangler.jsonc");
const ALL_SKIPPED = ["prereqs:skipped", "resources:skipped"];
const STAGING_ARGS = [...HOSTS, "--name", "open-artifacts-staging"];
const TEMPLATE = readFileSync(
  join(import.meta.dirname, "../../../apps/server/wrangler.template.jsonc"),
  "utf8",
);

describe("prereqs + resources", () => {
  it("first run on an empty account creates every resource in order", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.creates).toEqual([
      "d1 create open-artifacts",
      "r2 bucket create open-artifacts",
      "kv namespace create open-artifacts-oauth",
    ]);
    expect(statuses(w.lines).slice(0, 2)).toEqual([
      "prereqs:skipped",
      "resources:ok",
    ]);
    expect(JSON.parse(w.files.get(STATE) ?? "")).toMatchObject({
      accountId: "acc1",
      d1Id: "d1-0",
      r2Bucket: "open-artifacts",
      kvId: "kv-0",
    });
    expect(w.zoneQueries.every((q) => q.includes("status=active"))).toBe(true);
  });

  it("second run reports all skipped", async () => {
    const w = world();
    await run(HOSTS, w.deps, ROOT);
    w.lines.length = 0;
    w.creates.length = 0;
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.creates).toEqual([]);
    expect(statuses(w.lines).slice(0, 2)).toEqual(ALL_SKIPPED);
  });

  it("adopts staging's existing resources by name, even past the first KV page", async () => {
    const w = world({ ...STAGING, kv: [...filler(150), ...STAGING.kv] });
    expect(await run(STAGING_ARGS, w.deps, ROOT)).toBe(0);
    expect(w.creates).toEqual([]);
    expect(statuses(w.lines).slice(0, 2)).toEqual(ALL_SKIPPED);
    const cfg = JSON.parse(w.files.get(CONFIG) ?? "");
    expect(cfg.d1_databases[0].database_id).toBe(STAGING.d1[0].uuid);
    expect(cfg.kv_namespaces[0].id).toBe(STAGING.kv[0].id);
  });

  it("a staging neighbour is not mistaken for --name open-artifacts", async () => {
    const w = world({ ...STAGING, kv: [...filler(250), ...STAGING.kv] });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.creates).toEqual([
      "d1 create open-artifacts",
      "r2 bucket create open-artifacts",
      "kv namespace create open-artifacts-oauth",
    ]);
  });

  it("several accounts need --account-id under --yes", async () => {
    const w = world({ accounts: ["acc1", "acc2"] });
    const yesOnly = HOSTS.filter((a) => a !== "--json");
    expect(await run(yesOnly, w.deps, ROOT)).toBe(1);
    expect(w.lines.join("\n")).toContain("--account-id");
    const w2 = world({ accounts: ["acc1", "acc2"] });
    expect(await run([...HOSTS, "--account-id", "acc2"], w2.deps, ROOT)).toBe(
      0,
    );
  });

  it("renders the config with no placeholders and ENVIRONMENT=production", async () => {
    const w = world();
    await run(HOSTS, w.deps, ROOT);
    const text = w.files.get(CONFIG) ?? "";
    expect(text).not.toContain("{{");
    expect(text).toContain('"ENVIRONMENT": "production"');
    const cfg = JSON.parse(text);
    expect(cfg.vars.CF_ACCOUNT_ID).toBe("acc1");
    expect(cfg.routes[1].pattern).toBe("a.b.usercontent.example.com");
  });

  it("renderConfig escapes values, allows comments, and asserts production", () => {
    const vars = { OWNER_EMAIL: 'a"b\\c' };
    const tpl =
      '{\n  // c "x"\n  "vars": { "OWNER_EMAIL": "{{OWNER_EMAIL}}", "ENVIRONMENT": "production" } /* end */\n}';
    const out = renderConfig(tpl, vars).replace(/\/\/.*|\/\*.*\*\//g, "");
    expect(JSON.parse(out).vars.OWNER_EMAIL).toBe('a"b\\c');
    expect(() => renderConfig(tpl.replace("production", "dev"), vars)).toThrow(
      "ENVIRONMENT",
    );
    expect(() => renderConfig(TEMPLATE, {})).toThrow("{{");
  });

  it("the template is strict JSON (e2e fixtures JSON.parse it raw)", () => {
    const cfg = JSON.parse(TEMPLATE);
    expect(cfg.vars.WORKER_NAME).toBe("{{WORKER_NAME}}");
    expect(cfg.vars.OAUTH_KV_ID).toBe("{{KV_ID}}");
  });

  it("a host outside every account zone is action_required, exit 2", async () => {
    const w = world();
    const argv = HOSTS.map((a) =>
      a === "app.example.com" ? "app.other.dev" : a,
    );
    expect(await run(argv, w.deps, ROOT)).toBe(2);
    const last = JSON.parse(w.lines.at(-1) ?? "");
    expect(last).toMatchObject({
      step: "prereqs",
      status: "action_required",
      data: { missing: ["app.other.dev"] },
    });
    expect(w.creates).toEqual([]);
  });
});

describe("BROWSER binding (--no-browser)", () => {
  const VARS = {
    WORKER_NAME: "w",
    APP_HOST: "a.example.com",
    CONTENT_HOST: "c.example.com",
    OWNER_EMAIL: "o@example.com",
    D1_NAME: "d",
    D1_ID: "1",
    R2_BUCKET: "r",
    KV_ID: "k",
    CF_ACCOUNT_ID: "acc",
    ACCESS_TEAM_DOMAIN: "t",
    ACCESS_CLIENT_ID: "i",
  };
  it("renders the binding by default and omits it when off", () => {
    expect(
      JSON.parse(stripJsonc(renderConfig(TEMPLATE, VARS))).browser,
    ).toEqual({ binding: "BROWSER" });
    const off = renderConfig(TEMPLATE, VARS, false);
    expect(JSON.parse(stripJsonc(off))).not.toHaveProperty("browser");
    expect(off).not.toContain("BROWSER");
  });
  it("setup writes it on Paid, --no-browser drops it and --upgrade keeps that", async () => {
    const PAID = [{ rate_plan: { id: "WORKERS_PAID" }, state: "Paid" }];
    const on = world({ subscriptions: PAID });
    expect(await run(HOSTS, on.deps, ROOT)).toBe(0);
    expect(JSON.parse(on.files.get(CONFIG) ?? "").browser).toEqual({
      binding: "BROWSER",
    });
    const w = world({ subscriptions: PAID });
    expect(await run([...HOSTS, "--no-browser"], w.deps, ROOT)).toBe(0);
    expect(w.files.get(CONFIG)).not.toContain("BROWSER");
    expect(JSON.parse(w.files.get(STATE) ?? "").browser).toBe(false);
    expect(
      await run([...HOSTS, "--upgrade", "--no-browser"], w.deps, ROOT),
    ).toBe(0);
    expect(w.files.get(CONFIG)).not.toContain("BROWSER");
  });
  it("--check reports browser", async () => {
    const w = world();
    await run([...HOSTS, "--no-browser"], w.deps, ROOT);
    w.lines.length = 0;
    await run([...HOSTS.filter((a) => a !== "--yes"), "--check"], w.deps, ROOT);
    expect(JSON.parse(w.lines.at(-1) ?? "").data.browser).toBe(false);
  });
  it("--help lists --no-browser", async () => {
    const w = world();
    expect(await run(["--help"], w.deps, ROOT)).toBe(0);
    expect(w.lines.join("\n")).toContain("--no-browser");
  });
});
