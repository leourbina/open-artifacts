import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { renderConfig } from "../src/steps/resources.ts";
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
    expect(statuses(w.lines)).toEqual(["prereqs:skipped", "resources:ok"]);
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
    expect(statuses(w.lines)).toEqual(ALL_SKIPPED);
  });

  it("adopts staging's existing resources by name, even past the first KV page", async () => {
    const w = world({ ...STAGING, kv: [...filler(150), ...STAGING.kv] });
    expect(await run(STAGING_ARGS, w.deps, ROOT)).toBe(0);
    expect(w.creates).toEqual([]);
    expect(statuses(w.lines)).toEqual(ALL_SKIPPED);
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
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
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
