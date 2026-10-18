import { describe, expect, it, vi } from "vitest";
import { run } from "../src/index.ts";
import type { Step } from "../src/step.ts";
import { ROOT, STATE } from "./fakes.ts";
import { app, HOSTS, POLICY, world } from "./world.ts";

type W = ReturnType<typeof world>;
const parsed = (w: W) => w.lines.map((l) => JSON.parse(l));
const statuses = (w: W) => parsed(w).map((j) => `${j.step}:${j.status}`);
const line = (w: W, step: string) => parsed(w).find((j) => j.step === step);
const SECRETS = [
  "ACCESS_CLIENT_SECRET",
  "SESSION_SECRET",
  "CONTENT_SIGNING_KEY",
];
const CONFIG = `${ROOT}/apps/server/wrangler.jsonc`;
const UPGRADE = [...HOSTS, "--upgrade"];
const CHECK = [...HOSTS.filter((a) => a !== "--yes"), "--check"];

/** A cloud side that a full setup already built, with no local state file. */
const cloud = (o: Parameters<typeof world>[0] = {}) =>
  world({
    d1: [{ uuid: "d1-live", name: "open-artifacts" }],
    r2: [{ name: "open-artifacts" }],
    kv: [{ id: "kv-live", title: "open-artifacts-oauth" }],
    policies: [POLICY],
    apps: [app("open-artifacts")],
    secrets: SECRETS,
    ...o,
  });

const READ_ONLY = [
  /^whoami --json$/,
  /^auth token --json$/,
  /^secret list --name [\w-]+ --format json$/,
  /^d1 execute [\w-]+ --remote --json --command SELECT [^;]*;$/,
];
/** Fails (and records) any mutating wrangler call or non-GET API request. */
function strict(w: W) {
  const violations: string[] = [];
  const { exec, fetch } = w.deps;
  w.deps.exec = async (cmd, args, opts) => {
    if (args.includes("wrangler")) {
      const a = args.slice(args.indexOf("wrangler") + 1).join(" ");
      if (!READ_ONLY.some((re) => re.test(a))) {
        violations.push(`wrangler ${a}`);
        return { code: 1, stdout: "", stderr: "mutation refused by test" };
      }
    } else if (cmd === "pnpm" && args[0] !== "--version") {
      violations.push(`${cmd} ${args.join(" ")}`);
      return { code: 1, stdout: "", stderr: "refused" };
    }
    return exec(cmd, args, opts);
  };
  w.deps.fetch = async (input, init) => {
    const m = init?.method ?? "GET";
    if (m !== "GET") {
      violations.push(`${m} ${new URL(String(input)).pathname}`);
      return new Response("refused", { status: 599 });
    }
    return fetch(input, init);
  };
  return violations;
}

describe("--upgrade with no state rebuilds it from Cloudflare by name", () => {
  it("fills every id by lookup and creates nothing", async () => {
    const w = cloud();
    w.deps.env.OA_ACCESS_TOKEN = "oa-ci";
    expect(w.files.has(STATE)).toBe(false);
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(0);
    expect(w.creates).toEqual([]);
    expect(w.ops).toEqual(["build", "migrate open-artifacts", "deploy"]);
    expect(w.state()).toMatchObject({
      accountId: "acc1",
      d1Id: "d1-live",
      r2Bucket: "open-artifacts",
      kvId: "kv-live",
      accessAppId: "app-open-artifacts",
      accessClientId: "cid-open-artifacts",
      teamDomain: "team.cloudflareaccess.com",
    });
    expect(w.deployed()).toContain('"ACCESS_CLIENT_ID": "cid-open-artifacts"');
  });

  it("a missing resource is action_required, never created", async () => {
    const w = cloud({ kv: [] });
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(2);
    expect(w.creates).toEqual([]);
    expect(line(w, "resources")).toMatchObject({ status: "action_required" });
    expect(line(w, "resources").message).toContain("run a full setup first");
    expect(line(w, "resources").message).toContain("open-artifacts-oauth");
  });

  it("a missing Access app is action_required, no Access writes", async () => {
    const w = cloud({ apps: [], policies: [] });
    w.deps.env.OA_ACCESS_TOKEN = "oa-ci";
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(2);
    expect(w.ops).toEqual([]);
    expect(line(w, "access")).toMatchObject({ status: "action_required" });
    expect(line(w, "access").message).toContain("run a full setup first");
  });

  it("a missing generated secret is action_required, never put", async () => {
    const w = cloud({ secrets: ["ACCESS_CLIENT_SECRET"] });
    w.deps.env.OA_ACCESS_TOKEN = "oa-ci";
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(2);
    expect(w.ops).toEqual([]);
    expect(line(w, "secrets").message).toContain("run a full setup first");
  });

  it("policy drift is noted, not reconciled, under --upgrade", async () => {
    const w = cloud({ policies: [{ ...POLICY, require: [{ x: 1 }] }] });
    w.deps.env.OA_ACCESS_TOKEN = "oa-ci";
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(0);
    expect(w.ops).toEqual(["build", "migrate open-artifacts", "deploy"]);
    expect(line(w, "access").message).toContain("not reconciled");
  });
});

describe("team domain: app field, then organizations, then OA_TEAM_DOMAIN", () => {
  const orgCalls = (w: W) =>
    w.auths.filter((a) => a.includes("/access/organizations"));

  it("an app field naming <team>.cloudflareaccess.com wins, no org call", async () => {
    const withDomain = {
      ...app("open-artifacts"),
      domain: "team2.cloudflareaccess.com/cdn-cgi/access/sso/oidc/cid",
    };
    const w = cloud({ apps: [withDomain], org: "forbidden" });
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(0);
    expect(w.state().teamDomain).toBe("team2.cloudflareaccess.com");
    expect(orgCalls(w)).toEqual([]);
  });

  it("otherwise the organizations endpoint", async () => {
    const w = cloud();
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(0);
    expect(w.state().teamDomain).toBe("team.cloudflareaccess.com");
    expect(orgCalls(w).length).toBeGreaterThan(0);
  });

  it("on an organizations 403, OA_TEAM_DOMAIN", async () => {
    const w = cloud({ org: "forbidden" });
    w.deps.env.OA_TEAM_DOMAIN = "envteam.cloudflareaccess.com";
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(0);
    expect(w.state().teamDomain).toBe("envteam.cloudflareaccess.com");
  });

  it("OA_TEAM_DOMAIN never stands in when no app is visible (an unscoped token lists none)", async () => {
    const w = cloud({ apps: [], org: "forbidden" });
    w.deps.env.OA_TEAM_DOMAIN = "envteam.cloudflareaccess.com";
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    expect(w.ops).toEqual([]);
    expect(line(w, "access")).toMatchObject({ status: "action_required" });
    expect(line(w, "access").message).toContain("OA_ACCESS_TOKEN");
  });

  it("an invalid OA_TEAM_DOMAIN is an error", async () => {
    const w = cloud({ org: "forbidden" });
    w.deps.env.OA_TEAM_DOMAIN = "not a host";
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(1);
    expect(line(w, "access").message).toContain("OA_TEAM_DOMAIN");
  });

  it("every source failing is action_required naming OA_TEAM_DOMAIN", async () => {
    const w = cloud({ org: "forbidden" });
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(2);
    expect(line(w, "access")).toMatchObject({ status: "action_required" });
    expect(line(w, "access").message).toContain("OA_TEAM_DOMAIN");
    expect(w.ops).toEqual([]);
  });
});

describe("--check is read-only", () => {
  it("never calls apply", async () => {
    const apply = vi.fn(async () => undefined);
    const steps: Step[] = [
      { name: "a", check: async () => "todo", apply },
      { name: "b", check: async () => "done", apply },
    ];
    const w = world();
    expect(await run(CHECK, w.deps, ROOT, steps)).toBe(0);
    expect(apply).not.toHaveBeenCalled();
    expect(statuses(w)).toEqual(["a:todo", "b:done", "state:ok"]);
  });

  it("on an installed account: no mutations, no files, state in --json data", async () => {
    const w = cloud();
    w.deps.env.OA_ACCESS_TOKEN = "oa-secret-access-token";
    w.deps.env.CLOUDFLARE_API_TOKEN = "cf-secret-api-token";
    const violations = strict(w);
    const before = new Map(w.files);
    expect(await run(CHECK, w.deps, ROOT)).toBe(0);
    expect(violations).toEqual([]);
    expect(w.files).toEqual(before);
    expect(w.files.has(STATE)).toBe(false);
    expect(w.files.has(CONFIG)).toBe(false);
    expect(statuses(w)).toEqual([
      "prereqs:done",
      "resources:done",
      "access:done",
      "secrets:done",
      "deploy:todo",
      "owner-token:todo",
      "selftest:todo",
      "agent-config:done",
      "state:ok",
    ]);
    expect(line(w, "state").data).toEqual({
      name: "open-artifacts",
      accountId: "acc1",
      appHost: "app.example.com",
      contentHost: "a.b.usercontent.example.com",
      ownerEmail: "owner@example.com",
      d1Id: "d1-live",
      r2Bucket: "open-artifacts",
      kvId: "kv-live",
      accessAppId: "app-open-artifacts",
      accessClientId: "cid-open-artifacts",
      teamDomain: "team.cloudflareaccess.com",
    });
    const out = w.lines.join("\n");
    for (const s of ["oa-secret-access-token", "cf-secret-api-token"])
      expect(out).not.toContain(s);
  });

  it("on an empty account: everything todo, still nothing mutated", async () => {
    const w = world({ org: "forbidden" });
    const violations = strict(w);
    expect(await run(CHECK, w.deps, ROOT)).toBe(0);
    expect(violations).toEqual([]);
    expect(w.files.has(STATE)).toBe(false);
    expect(w.creates).toEqual([]);
    expect(statuses(w).slice(1, 4)).toEqual([
      "resources:todo",
      "access:todo",
      "secrets:todo",
    ]);
    expect(line(w, "access").message).toContain("OA_ACCESS_TOKEN");
  });

  it("refuses mutating calls even if a step tried one", async () => {
    const rogue: Step = {
      name: "rogue",
      check: async (_s, ctx) => {
        await ctx.wrangler(["d1", "create", "x"]);
        return "done";
      },
      apply: async () => undefined,
    };
    const rogueApi: Step = {
      name: "rogue-api",
      check: async (_s, ctx) => {
        await ctx.accessApi("DELETE", "/accounts/acc1/access/apps/x");
        return "done";
      },
      apply: async () => undefined,
    };
    for (const step of [rogue, rogueApi]) {
      const w = world();
      expect(await run(CHECK, w.deps, ROOT, [step])).toBe(1);
      expect(w.creates).toEqual([]);
      expect(w.ops).toEqual([]);
      expect(w.lines.at(-1)).toContain("--check is read-only");
    }
  });

  it("human output marks done and todo", async () => {
    const w = cloud();
    w.deps.env.OA_ACCESS_TOKEN = "oa";
    const argv = CHECK.filter((a) => a !== "--json");
    expect(await run(argv, w.deps, ROOT)).toBe(0);
    expect(w.lines[0]).toMatch(/^✓ prereqs: done/);
    expect(w.lines.find((l) => l.includes("deploy"))).toMatch(
      /^○ deploy: todo/,
    );
  });
});
