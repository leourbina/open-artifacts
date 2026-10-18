import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { ROOT } from "./fakes.ts";
import { app, HOSTS, POLICY, STAGING, world } from "./world.ts";

type W = ReturnType<typeof world>;
const parsed = (w: W) => w.lines.map((l) => JSON.parse(l));
const statuses = (w: W) => parsed(w).map((j) => `${j.step}:${j.status}`);
const interactive = HOSTS.filter((a) => a !== "--yes");
const SECRETS = [
  "ACCESS_CLIENT_SECRET",
  "SESSION_SECRET",
  "CONTENT_SIGNING_KEY",
];
const CONFIG = `${ROOT}/apps/server/wrangler.jsonc`;

/** Every secret value the fake saw must be absent from output, json, state and files. */
function noLeak(w: W, extra: string[] = []) {
  const haystack = [...w.lines, ...w.prompts, ...w.files.values()].join("\n");
  for (const v of [...w.values, ...extra]) {
    expect(v.length).toBeGreaterThan(0);
    expect(haystack).not.toContain(v);
  }
}

describe("access + secrets", () => {
  it("first run creates everything in order and fills the config", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.ops).toEqual([
      "POST policies",
      "POST apps",
      ...SECRETS.map((s) => `put ${s}`),
    ]);
    expect(statuses(w)).toEqual([
      "prereqs:skipped",
      "resources:ok",
      "access:ok",
      "secrets:ok",
    ]);
    expect(w.apps[0]).toMatchObject({
      name: "open-artifacts",
      policies: [{ id: "pol1" }],
    });
    expect(w.apps[0].saas_app).toMatchObject({
      auth_type: "oidc",
      redirect_uris: ["https://app.example.com/auth/callback"],
      grant_types: ["authorization_code_with_pkce"],
      allow_pkce_without_client_secret: false,
      scopes: ["openid", "email", "profile"],
    });
    expect(w.state()).toMatchObject({
      teamDomain: "team.cloudflareaccess.com",
      accessAppId: "app-open-artifacts",
      accessClientId: "cid-new",
    });
    const vars = JSON.parse(w.files.get(CONFIG) ?? "").vars;
    expect(vars).toMatchObject({
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      ACCESS_CLIENT_ID: "cid-new",
    });
    expect(w.values.filter((v) => /^[A-Za-z0-9_-]{43}$/.test(v))).toHaveLength(
      2,
    );
    noLeak(w);
  });

  it("a rerun is all skipped; --upgrade skips even with policy drift", async () => {
    const w = world();
    await run(HOSTS, w.deps, ROOT);
    w.lines.length = 0;
    w.ops.length = 0;
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(statuses(w).every((s) => s.endsWith(":skipped"))).toBe(true);
    w.policies[0].include = [{ email: { email: "x@example.com" } }];
    w.lines.length = 0;
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(statuses(w).every((s) => s.endsWith(":skipped"))).toBe(true);
    expect(w.ops).toEqual([]);
  });

  it("a 403 on organizations is action_required with the token link, exit 2", async () => {
    const w = world({ org: "forbidden" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    const last = parsed(w).at(-1);
    expect(last).toMatchObject({ step: "access", status: "action_required" });
    expect(last.data.url).toContain(
      "https://dash.cloudflare.com/profile/api-tokens?",
    );
    expect(w.ops).toEqual([]);
  });

  it("prompts for CF_API_TOKEN without echo and keeps it in memory only", async () => {
    const w = world({ org: "forbidden", answers: ["USER-TOKEN-abc", ""] });
    expect(await run(interactive, w.deps, ROOT)).toBe(0);
    expect(w.prompts[0]).toMatch(/^\[secret\] .*CF_API_TOKEN/);
    expect(w.ops).toContain("POST apps");
    noLeak(w, ["USER-TOKEN-abc"]);
  });

  it("rolls the app back when the client-secret put fails", async () => {
    const w = world({ putFails: "ACCESS_CLIENT_SECRET" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    expect(w.ops).toEqual([
      "POST policies",
      "POST apps",
      "DELETE apps/app-open-artifacts",
    ]);
    expect(w.apps).toEqual([]);
    expect(parsed(w).at(-1)).toMatchObject({ step: "access", status: "error" });
    noLeak(w);
  });

  it("a failed rollback logs both error names and rethrows the original", async () => {
    const w = world({ putFails: "ACCESS_CLIENT_SECRET", deleteFails: true });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    const last = parsed(w).at(-1);
    expect(last.message).toContain("secret put ACCESS_CLIENT_SECRET failed");
    expect(last.message).toContain("rollback");
    noLeak(w);
  });

  it("an existing app without the Worker secret is action_required", async () => {
    const w = world({
      policies: [POLICY],
      apps: [app("open-artifacts")],
      secrets: [],
    });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    expect(parsed(w).at(-1)).toMatchObject({
      step: "access",
      status: "action_required",
    });
    expect(parsed(w).at(-1).message).toMatch(/delete the Access app/i);
    expect(w.ops).toEqual([]);
  });

  it("an existing app without the policy is action_required, never PUT", async () => {
    const w = world({
      policies: [POLICY],
      apps: [app("open-artifacts", [])],
      secrets: SECRETS,
    });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    expect(parsed(w).at(-1).message).toContain("Open Artifacts – everyone");
    expect(w.ops).toEqual([]);
  });

  it("no organization is action_required with the Zero Trust link", async () => {
    const w = world({ org: "none" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    expect(parsed(w).at(-1).message).toContain(
      "https://one.dash.cloudflare.com/",
    );
  });

  it("reconciles policy drift in place, keeping session_duration", async () => {
    const drifted = {
      ...POLICY,
      include: [{ email: { email: "x@example.com" } }],
      session_duration: "24h",
    };
    const w = world({ policies: [drifted] });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.ops[0]).toBe("PUT policies/pol1");
    expect(w.policies[0]).toMatchObject({
      include: [{ everyone: {} }],
      session_duration: "24h",
    });
  });

  it("adopts staging: app, policy and all four secrets present → skipped", async () => {
    const secrets = [...SECRETS, "CF_ACCOUNT_ID"];
    const w = world({
      ...STAGING,
      policies: [POLICY],
      apps: [app("open-artifacts-staging")],
      secrets,
    });
    expect(
      await run([...HOSTS, "--name", "open-artifacts-staging"], w.deps, ROOT),
    ).toBe(0);
    expect(statuses(w)).toEqual([
      "prereqs:skipped",
      "resources:skipped",
      "access:skipped",
      "secrets:skipped",
    ]);
    expect(w.ops).toEqual([]);
    expect(w.state()).toMatchObject({
      accessClientId: "cid-open-artifacts-staging",
    });
  });

  it("ANALYTICS_TOKEN is prompted interactively and optional", async () => {
    const w = world({ answers: ["ANALYTICS-val"] });
    expect(await run(interactive, w.deps, ROOT)).toBe(0);
    expect(w.ops.at(-1)).toBe("put ANALYTICS_TOKEN");
    noLeak(w);
  });
});
