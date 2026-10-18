import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPat } from "../../../packages/shared/src/ids.ts";
import { run } from "../src/index.ts";
import { deploy } from "../src/steps/deploy.ts";
import { newPat, ownerSql } from "../src/steps/owner-token.ts";
import { ROOT, STATE } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

type W = ReturnType<typeof world>;
const parsed = (w: W) => w.lines.map((l) => JSON.parse(l));
const statuses = (w: W) => parsed(w).map((j) => `${j.step}:${j.status}`);
const CONFIG = join(ROOT, "apps/server/wrangler.jsonc");
const SECRETS = [
  "ACCESS_CLIENT_SECRET",
  "SESSION_SECRET",
  "CONTENT_SIGNING_KEY",
];
const ALL = [
  "prereqs",
  "resources",
  "access",
  "secrets",
  "deploy",
  "owner-token",
  "selftest",
  "agent-config",
];
const WELCOME = readFileSync(
  join(import.meta.dirname, "../welcome.md"),
  "utf8",
);
const line = (w: W, step: string) => parsed(w).find((j) => j.step === step);
const patOf = (w: W): string => line(w, "owner-token").data.token;

/** The PAT is only in owner-token's and agent-config's lines: never state, files, argv, prompts or other steps. */
function patContained(w: W, pat: string) {
  expect(isPat(pat)).toBe(true);
  const others = w.lines.filter(
    (l) => !/^(\{"step":"|. )(owner-token|agent-config)/.test(l),
  );
  const hay = [...others, ...w.files.values(), ...w.argv, ...w.prompts];
  expect(hay.join("\n")).not.toContain(pat);
  expect(w.sqls.join("\n")).toContain(
    createHash("sha256").update(pat).digest("hex"),
  );
}

/** A world whose cloud side is fully set up, then run once. */
async function installed() {
  const w = world();
  expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
  w.lines.length = 0;
  w.ops.length = 0;
  w.hits.length = 0;
  w.mcpCalls.length = 0;
  return w;
}

/** State and config as after the access step, for running `deploy` alone. */
function deployWorld(vars: Record<string, string>, secrets = SECRETS) {
  const w = world({
    secrets,
    state: { name: "open-artifacts", accountId: "acc1" },
  });
  const cfg = {
    name: "open-artifacts",
    vars: {
      ENVIRONMENT: "production",
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      ACCESS_CLIENT_ID: "cid",
      CF_ACCOUNT_ID: "acc1",
      ...vars,
    },
  };
  w.files.set(CONFIG, `// rendered\n${JSON.stringify(cfg, null, 2)}`);
  return w;
}

describe("deploy, owner-token, selftest, agent-config", () => {
  it("a first run over an empty account runs every step in order, exit 0", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(statuses(w)).toEqual([
      "prereqs:skipped",
      ...ALL.slice(1).map((s) => `${s}:ok`),
    ]);
    expect(w.ops).toEqual([
      "POST policies",
      "POST apps",
      ...SECRETS.map((s) => `put ${s}`),
      "build",
      "migrate open-artifacts",
      "deploy",
      "d1 owner+token",
    ]);
    expect(w.hits).toEqual([
      "GET /healthz",
      "GET /cdn-cgi/access/sso/oidc/cid-new/.well-known/openid-configuration",
      "mcp initialize",
      "mcp notifications/initialized",
      "mcp tools/list",
      "mcp tools/call",
      "GET /a/art1",
    ]);
    expect(w.mcpCalls[0]).toEqual({
      name: "publish_artifact",
      arguments: {
        title: "Welcome to Open Artifacts",
        format: "markdown",
        content: WELCOME,
      },
    });
    expect(w.db.users).toEqual([
      { id: expect.any(String), email: "owner@example.com", role: "owner" },
    ]);
    const st = w.state();
    expect(st.deployedVersion).toBe("0.1.0");
    expect(st.ownerTokenId).toBe(w.db.tokens[0].id);
    expect(JSON.parse(w.deployed() ?? "").vars.ENVIRONMENT).toBe("production");
    expect(line(w, "selftest").data).toMatchObject({
      artifactUrl: "https://app.example.com/a/art1",
    });
    const pat = patOf(w);
    patContained(w, pat);
    const cfg = line(w, "agent-config").data;
    expect(cfg.url).toBe("https://app.example.com/mcp");
    for (const s of Object.values(cfg.snippets) as string[]) {
      expect(s).toContain("https://app.example.com/mcp");
      expect(s).toContain(`Bearer ${pat}`);
    }
    expect(cfg.snippets.claudeCode).toMatch(
      /^claude mcp add --transport http open-artifacts https:\/\/app\.example\.com\/mcp --header "Authorization: Bearer oa_pat_/,
    );
    expect(cfg.snippets.codex).toContain("[mcp_servers.open-artifacts]");
    expect(JSON.parse(cfg.snippets.cursor.replace(/^\/\/.*\n/, ""))).toEqual({
      mcpServers: {
        "open-artifacts": {
          url: "https://app.example.com/mcp",
          headers: { Authorization: `Bearer ${pat}` },
        },
      },
    });
    expect(
      JSON.parse(cfg.snippets.opencode.replace(/^\/\/.*\n/, "")).mcp[
        "open-artifacts"
      ],
    ).toMatchObject({ type: "remote", url: "https://app.example.com/mcp" });
    expect(JSON.parse(cfg.snippets.json).mcpServers["open-artifacts"]).toEqual({
      type: "http",
      url: "https://app.example.com/mcp",
      headers: { Authorization: `Bearer ${pat}` },
    });
  });

  it("a rerun skips all but deploy and selftest; selftest skips MCP without a fresh token", async () => {
    const w = await installed();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(statuses(w)).toEqual(
      ALL.map(
        (s) => `${s}:${s === "deploy" || s === "selftest" ? "ok" : "skipped"}`,
      ),
    );
    expect(w.ops).toEqual(["build", "migrate open-artifacts", "deploy"]);
    expect(w.db.tokens).toHaveLength(1);
    expect(w.hits).toEqual([
      "GET /healthz",
      "GET /cdn-cgi/access/sso/oidc/cid-new/.well-known/openid-configuration",
    ]);
    expect(line(w, "selftest").message).toMatch(
      /MCP check skipped.*--new-owner-token/,
    );
    const cfg = line(w, "agent-config");
    expect(cfg.message).toContain("<YOUR_TOKEN>");
    expect(cfg.data.snippets.claudeCode).toContain("Bearer <YOUR_TOKEN>");
    expect(w.lines.join("\n")).not.toMatch(/oa_pat_/);
  });

  it("--new-owner-token mints another; a revoked token is re-minted", async () => {
    const w = await installed();
    const first = w.state().ownerTokenId;
    expect(await run([...HOSTS, "--new-owner-token"], w.deps, ROOT)).toBe(0);
    expect(w.db.tokens).toHaveLength(2);
    expect(w.state().ownerTokenId).not.toBe(first);
    expect(w.hits).toContain("mcp tools/call");
    patContained(w, patOf(w));
    w.lines.length = 0;
    w.db.tokens[1].revoked_at = 1;
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(line(w, "owner-token").status).toBe("ok");
    expect(w.db.tokens).toHaveLength(3);
  });

  it("--upgrade runs only deploy and selftest; --new-owner-token adds a token", async () => {
    const w = await installed();
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(statuses(w)).toEqual(
      ALL.map(
        (s) => `${s}:${s === "deploy" || s === "selftest" ? "ok" : "skipped"}`,
      ),
    );
    expect(w.ops).toEqual(["build", "migrate open-artifacts", "deploy"]);
    expect(w.sqls).toHaveLength(1); // the first run's insert only
    w.lines.length = 0;
    const argv = [...HOSTS, "--upgrade", "--new-owner-token"];
    expect(await run(argv, w.deps, ROOT)).toBe(0);
    expect(statuses(w).slice(4)).toEqual([
      "deploy:ok",
      "owner-token:ok",
      "selftest:ok",
      "agent-config:ok",
    ]);
  });

  it("refuses a dev config before building or deploying", async () => {
    const w = deployWorld({ ENVIRONMENT: "dev" });
    expect(await run(HOSTS, w.deps, ROOT, [deploy])).toBe(1);
    expect(line(w, "deploy")).toMatchObject({ status: "error" });
    expect(line(w, "deploy").message).toMatch(/refusing.*ENVIRONMENT.*dev/);
    expect(w.ops).toEqual([]);
  });

  it("refuses empty ACCESS_TEAM_DOMAIN or ACCESS_CLIENT_ID", async () => {
    for (const k of ["ACCESS_TEAM_DOMAIN", "ACCESS_CLIENT_ID"]) {
      const w = deployWorld({ [k]: "" });
      expect(await run(HOSTS, w.deps, ROOT, [deploy])).toBe(1);
      expect(line(w, "deploy").message).toMatch(new RegExp(`refusing.*${k}`));
      expect(w.ops).toEqual([]);
    }
  });

  it("refuses when a required Worker secret is missing", async () => {
    const w = deployWorld({}, SECRETS.slice(0, 2));
    expect(await run(HOSTS, w.deps, ROOT, [deploy])).toBe(1);
    expect(line(w, "deploy").message).toContain("CONTENT_SIGNING_KEY");
    expect(w.ops).toEqual([]);
  });

  it("deletes a secret that shadows a rendered var before deploying, names only", async () => {
    const w = deployWorld({}, [...SECRETS, "CF_ACCOUNT_ID", "ANALYTICS_TOKEN"]);
    expect(await run(HOSTS, w.deps, ROOT, [deploy])).toBe(0);
    expect(w.ops).toEqual([
      "delete secret CF_ACCOUNT_ID",
      "build",
      "migrate open-artifacts",
      "deploy",
    ]);
    expect(line(w, "deploy").message).toContain("CF_ACCOUNT_ID");
    expect(w.state().deployedVersion).toBe("0.1.0");
  });

  it("selftest retries propagation with bounded backoff", async () => {
    const w = world({ healthFails: 3 });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.sleeps).toEqual([1000, 2000, 4000]);
    const down = world({ healthFails: 1000 });
    expect(await run(HOSTS, down.deps, ROOT)).toBe(1);
    expect(line(down, "selftest").message).toContain("/healthz");
    const total = down.sleeps.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(55_000);
    expect(total).toBeLessThanOrEqual(65_000);
    patContained(down, patOf(down));
  });

  it("selftest errors when tools/list lacks publish_artifact", async () => {
    const w = world({ noPublishTool: true });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    expect(line(w, "selftest").message).toContain("publish_artifact");
    expect(w.mcpCalls).toEqual([]);
  });

  it("human output shows the token once in owner-token, plus agent-config snippets", async () => {
    const w = world();
    const human = HOSTS.filter((a) => a !== "--json");
    expect(await run(human, w.deps, ROOT)).toBe(0);
    const tokenId = JSON.parse(w.files.get(STATE) ?? "").ownerTokenId;
    const own = w.lines.find((l) => l.startsWith("✓ owner-token")) ?? "";
    const pat = own.match(/oa_pat_\w+/)?.[0] ?? "";
    expect(own.split(pat)).toHaveLength(2);
    expect(own).toContain(tokenId);
    const cfg = w.lines.find((l) => l.startsWith("✓ agent-config")) ?? "";
    expect(cfg).toContain("claude mcp add --transport http");
    expect(cfg).toContain(`Bearer ${pat}`);
    patContained(w, pat);
  });

  it("every --json line parses, across first run, rerun and upgrade", async () => {
    const w = world();
    await run(HOSTS, w.deps, ROOT);
    await run(HOSTS, w.deps, ROOT);
    await run([...HOSTS, "--upgrade", "--new-owner-token"], w.deps, ROOT);
    expect(w.lines.length).toBe(24);
    for (const l of w.lines)
      expect(Object.keys(JSON.parse(l))).toEqual(
        expect.arrayContaining(["step", "status", "message"]),
      );
  });

  it("the local PAT matches @oa/shared's format; SQL escapes and carries only the hash", () => {
    for (let i = 0; i < 50; i++) expect(isPat(newPat())).toBe(true);
    const sql = ownerSql("o'brien@example.com", "tid", "ab".repeat(32), 1);
    expect(sql).toContain("'o''brien@example.com'");
    expect(sql).not.toMatch(/oa_pat_/);
    expect(sql).toContain("ON CONFLICT(email) DO UPDATE SET role = 'owner'");
  });
});
