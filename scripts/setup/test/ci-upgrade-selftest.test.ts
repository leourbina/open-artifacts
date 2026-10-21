import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { ROOT } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

type W = ReturnType<typeof world>;
const CI = [...HOSTS.filter((a) => a !== "--yes"), "--ci"];
const parsed = (w: W) => w.lines.map((l) => JSON.parse(l));
const line = (w: W, s: string) => parsed(w).find((j) => j.step === s);

/** An existing install, so --upgrade has a Worker to upgrade. */
async function installed(
  opts: NonNullable<Parameters<typeof world>[0]> = {},
  argv = CI,
) {
  const w = world(opts);
  expect(await run(argv, w.deps, ROOT)).toBe(0);
  w.lines.length = 0;
  w.sqls.length = 0;
  w.bearers.clear();
  return w;
}
const live = (w: W) =>
  w.db.tokens.filter((t) => t.label === "setup-ci" && !t.revoked_at);

describe("--ci --upgrade selftest (#171)", () => {
  it("runs the full MCP publish and content check and leaves 0 live setup-ci tokens", async () => {
    const w = await installed();
    const before = w.db.tokens.length;
    expect(await run([...CI, "--upgrade"], w.deps, ROOT)).toBe(0);
    const st = line(w, "selftest");
    expect(st.data.mcp).toBe("ok");
    expect(st.data.content).toBeTruthy();
    expect(w.bearers.size).toBeGreaterThan(0);
    expect(w.db.tokens.length).toBe(before + 1);
    expect(live(w)).toHaveLength(0);
    expect(parsed(w).at(-1)).toMatchObject({
      step: "revoke-ci-token",
      status: "ok",
    });
  });

  it("a selftest failure still revokes the token", async () => {
    const opts = {} as NonNullable<Parameters<typeof world>[0]>;
    const w = await installed(opts);
    opts.noPublishTool = true;
    expect(await run([...CI, "--upgrade"], w.deps, ROOT)).toBe(1);
    expect(line(w, "selftest").status).toBe("error");
    expect(live(w)).toHaveLength(0);
    expect(parsed(w).at(-1)).toMatchObject({
      step: "revoke-ci-token",
      status: "ok",
    });
  });

  it("a mint failure fails the selftest instead of skipping it", async () => {
    const opts = {} as NonNullable<Parameters<typeof world>[0]>;
    const w = await installed(opts);
    opts.d1Fails = true; // the token INSERT fails
    expect(await run([...CI, "--upgrade"], w.deps, ROOT)).not.toBe(0);
    // The run stops at the failed mint (owner-token) or fails in selftest; selftest never reports ok or skipped.
    const st = line(w, "selftest");
    if (st) expect(st.status).toBe("error");
    expect(
      parsed(w).some(
        (j) => j.status === "action_required" || j.status === "error",
      ),
    ).toBe(true);
    expect(JSON.stringify(parsed(w))).not.toContain("MCP check skipped");
    expect(live(w)).toHaveLength(0);
  });

  it("the token value never appears in output lines", async () => {
    const w = await installed();
    expect(await run([...CI, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(w.bearers.size).toBeGreaterThan(0);
    const hay = [...w.lines, ...w.values, ...w.argv].join("\n");
    expect(/oa_pat_/.test(hay)).toBe(false);
    for (const pat of w.bearers) expect(hay.includes(pat)).toBe(false);
  });

  it("non-CI --upgrade keeps today's behavior: no mint, selftest skipped", async () => {
    const w = await installed({}, HOSTS);
    const before = w.db.tokens.length;
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(w.db.tokens).toHaveLength(before);
    expect(line(w, "owner-token").message).toContain("kept (--upgrade)");
    expect(line(w, "revoke-ci-token")).toBeUndefined();
  });
});

describe("welcome lookup is exact and never duplicates the page", () => {
  const welcome = readFileSync(
    join(import.meta.dirname, "../welcome.md"),
    "utf8",
  );
  const filler = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `x${i}`, title: `Other ${i}` }));
  const pubs = (w: W) =>
    w.mcpCalls.filter((c) => c.name === "publish_artifact");

  it("finds it by exact title with search_artifacts and republishes nothing when unchanged", async () => {
    const w = world({
      existingArtifacts: [
        ...filler(3),
        { id: "art-w", title: "Welcome to Open Artifacts" },
      ],
      welcomeContent: welcome,
      contentBody: welcome,
    });
    expect(await run(CI, w.deps, ROOT)).toBe(0);
    expect(w.mcpCalls.some((c) => c.name === "search_artifacts")).toBe(true);
    expect(pubs(w)).toHaveLength(0);
    expect(line(w, "selftest").message).toContain("unchanged");
  });

  it("pages list_artifacts when the server has no search_artifacts", async () => {
    // The page sits past the first 100 items: a fixed limit-100 lookup misses it.
    const w = world({
      noSearchTool: true,
      existingArtifacts: [
        ...filler(120),
        { id: "art-w", title: "Welcome to Open Artifacts" },
      ],
      welcomeContent: welcome,
      contentBody: welcome,
    });
    expect(await run(CI, w.deps, ROOT)).toBe(0);
    expect(pubs(w)).toHaveLength(0);
    expect(line(w, "selftest").message).toContain("unchanged");
  });

  it("updates the found page instead of publishing a second one when the text changed", async () => {
    const w = world({
      existingArtifacts: [{ id: "art-w", title: "Welcome to Open Artifacts" }],
      welcomeContent: "old text",
    });
    expect(await run(CI, w.deps, ROOT)).toBe(0);
    const p = pubs(w);
    expect(p).toHaveLength(1);
    expect(p[0].arguments.id).toBe("art-w");
  });
});

describe("owner-token under --upgrade never moves ownership", () => {
  it("skips both the demote and role='owner'", async () => {
    const w = await installed();
    expect(await run([...CI, "--upgrade"], w.deps, ROOT)).toBe(0);
    const all = w.sqls.join("; ");
    expect(all).not.toContain("SET role");
    expect(all).toContain("ON CONFLICT(email) DO NOTHING");
  });

  it("fails when a different owner exists, without demoting it", async () => {
    const w = await installed();
    const me = w.db.users.find((u) => u.email === "owner@example.com");
    if (me) me.role = "admin";
    w.db.users.push({
      id: "u-other",
      email: "other@example.com",
      role: "owner",
    });
    const before = w.db.tokens.length;
    w.lines.length = 0;
    w.sqls.length = 0;
    expect(await run([...CI, "--upgrade"], w.deps, ROOT)).not.toBe(0);
    expect(line(w, "owner-token")).toMatchObject({ status: "error" });
    expect(line(w, "owner-token").message).toContain("won't change ownership");
    expect(
      w.db.users.filter((u) => u.role === "owner").map((u) => u.email),
    ).toEqual(["other@example.com"]);
    expect(w.sqls.join("; ")).not.toContain("SET role");
    expect(w.db.tokens).toHaveLength(before);
  });

  it("fails when the configured owner has no row, instead of creating one", async () => {
    const w = await installed();
    w.db.users = [];
    w.lines.length = 0;
    expect(await run([...CI, "--upgrade"], w.deps, ROOT)).not.toBe(0);
    expect(line(w, "owner-token")).toMatchObject({ status: "error" });
    expect(line(w, "owner-token").message).toContain("no user row");
    expect(w.db.users.map((u) => u.email)).not.toContain("owner@example.com");
  });
});
