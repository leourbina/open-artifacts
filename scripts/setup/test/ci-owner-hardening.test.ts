import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { ROOT } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

type W = ReturnType<typeof world>;
type Opts = NonNullable<Parameters<typeof world>[0]>;
const CI = [...HOSTS.filter((a) => a !== "--yes"), "--ci"];
const parsed = (w: W) => w.lines.map((l) => JSON.parse(l));
const line = (w: W, s: string) => parsed(w).find((j) => j.step === s);
const roles = (w: W) => w.db.users.map((u) => `${u.email}:${u.role}`).sort();
const live = (w: W) =>
  w.db.tokens.filter((t) => t.label === "setup-ci" && !t.revoked_at);

async function installed(opts: Opts = {}, argv = CI) {
  const w = world(opts);
  expect(await run(argv, w.deps, ROOT)).toBe(0);
  w.lines.length = 0;
  w.sqls.length = 0;
  w.bearers.clear();
  w.mcpCalls.length = 0;
  return w;
}

describe("welcome lookup accepts only the owner's own page", () => {
  const welcome = readFileSync(
    join(import.meta.dirname, "../welcome.md"),
    "utf8",
  );
  const T = "Welcome to Open Artifacts";
  const foreign = [
    { id: "v1", title: T, access: "viewer" as const },
    { id: "e1", title: T, access: "editor" as const },
  ];
  const pubs = (w: W) =>
    w.mcpCalls.filter((c) => c.name === "publish_artifact");
  const ids = (w: W) => pubs(w).map((c) => c.arguments?.id);

  for (const [label, extra] of [
    ["search_artifacts", {}],
    ["list_artifacts", { noSearchTool: true }],
  ] as const) {
    it(`${label}: skips same-title viewer and editor hits ranked first, uses the owner's page`, async () => {
      const w = world({
        ...extra,
        existingArtifacts: [...foreign, { id: "mine", title: T }],
        welcomeContent: welcome,
        contentBody: welcome,
      });
      expect(await run(CI, w.deps, ROOT)).toBe(0);
      expect(pubs(w)).toHaveLength(0);
      expect(w.mcpCalls.some((c) => c.arguments?.id === "v1")).toBe(false);
      expect(w.mcpCalls.some((c) => c.arguments?.id === "e1")).toBe(false);
      expect(
        w.mcpCalls.some(
          (c) => c.name === "get_artifact" && c.arguments?.id === "mine",
        ),
      ).toBe(true);
    });

    it(`${label}: publishes a new page when only foreign pages share the title`, async () => {
      const w = world({
        ...extra,
        existingArtifacts: foreign,
        welcomeContent: welcome,
      });
      expect(await run(CI, w.deps, ROOT)).toBe(0);
      expect(pubs(w)).toHaveLength(1);
      expect(ids(w)[0]).toBeUndefined();
      expect(w.mcpCalls.some((c) => c.arguments?.id === "v1")).toBe(false);
      expect(w.mcpCalls.some((c) => c.arguments?.id === "e1")).toBe(false);
    });
  }
});

describe("--upgrade owner token SQL", () => {
  it("sends no users INSERT and no role change", async () => {
    const w = await installed();
    const before = roles(w);
    expect(await run([...CI, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(w.sqls.join("\n")).not.toMatch(/INSERT INTO users/);
    expect(w.sqls.join("\n")).not.toMatch(/SET role/);
    expect(roles(w)).toEqual(before);
    expect(live(w)).toHaveLength(0);
  });

  it("a row that vanishes after the pre-check gives no token row and no new owner", async () => {
    const opts: Opts = {};
    const w = await installed(opts);
    const tokens = w.db.tokens.length;
    opts.onSql = (sql) => {
      if (sql.includes("INSERT INTO tokens")) w.db.users.length = 0;
    };
    expect(await run([...CI, "--upgrade"], w.deps, ROOT)).not.toBe(0);
    expect(w.db.users).toHaveLength(0);
    expect(w.db.tokens).toHaveLength(tokens);
  });

  it("a pre-check failure reports no revoke for a token that was never minted", async () => {
    const w = await installed();
    w.db.users.push({ id: "u2", email: "other@example.com", role: "owner" });
    expect(await run([...CI, "--upgrade"], w.deps, ROOT)).not.toBe(0);
    expect(JSON.stringify(parsed(w))).toContain("won't change ownership");
    expect(line(w, "revoke-ci-token")).toBeUndefined();
    expect(JSON.stringify(parsed(w))).not.toContain("revoked CI owner token");
  });

  it("a mint error after the pre-check passes fails cleanly: no role change, no live token", async () => {
    const opts: Opts = {};
    const w = await installed(opts);
    const before = roles(w);
    const tokens = w.db.tokens.length;
    opts.d1Fails = true;
    expect(await run([...CI, "--upgrade"], w.deps, ROOT)).not.toBe(0);
    expect(roles(w)).toEqual(before);
    expect(w.db.tokens).toHaveLength(tokens);
    expect(live(w)).toHaveLength(0);
    expect(w.sqls.join("\n")).not.toMatch(/SET role/);
    expect(line(w, "selftest")?.status).not.toBe("ok");
  });
});

describe("an owner email with a quote is escaped in every statement", () => {
  const QUOTED = [
    ...CI.map((a) => (a === "owner@example.com" ? "o'brien@x.test" : a)),
  ];
  it("install and --upgrade both succeed and never send a bare quote", async () => {
    const w = world();
    expect(await run(QUOTED, w.deps, ROOT)).toBe(0);
    expect(await run([...QUOTED, "--upgrade"], w.deps, ROOT)).toBe(0);
    const withEmail = w.sqls.filter((s) => s.includes("brien"));
    expect(withEmail.length).toBeGreaterThan(0);
    for (const s of withEmail) {
      expect(s).toContain("o''brien");
      expect(s.replaceAll("o''brien", "")).not.toContain("brien");
    }
    expect(w.db.users.map((u) => u.email)).toEqual(["o'brien@x.test"]);
    expect(live(w)).toHaveLength(0);
  });
});
