import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { ROOT, STATE } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

type W = ReturnType<typeof world>;
const CI = [...HOSTS.filter((a) => a !== "--yes"), "--ci"];
const parsed = (w: W) => w.lines.map((l) => JSON.parse(l));
const line = (w: W, s: string) => parsed(w).find((j) => j.step === s);

/** The PAT is learned from what the app host saw; it must appear nowhere else. */
function noPat(w: W) {
  expect(w.bearers.size).toBeGreaterThan(0);
  const decoded = w.lines.map((l) => JSON.stringify(JSON.parse(l)));
  const hay = [
    ...w.lines,
    ...decoded,
    ...w.files.values(),
    ...w.argv,
    ...w.prompts,
    ...w.sqls,
    ...w.values,
  ].join("\n");
  for (const pat of w.bearers) {
    expect(pat).toMatch(/^oa_pat_/);
    expect(hay).not.toContain(pat);
  }
  expect(hay).not.toMatch(/oa_pat_/);
}
const REVOKE = /^UPDATE tokens SET revoked_at = \d+ WHERE id = '(\w+)'/;
const revokes = (w: W) => w.sqls.filter((s) => REVOKE.test(s));

describe("--ci", () => {
  it("never leaks the PAT into lines, json, files, state, argv or env", async () => {
    const w = world();
    expect(await run(CI, w.deps, ROOT)).toBe(0);
    noPat(w);
    expect(line(w, "owner-token").message).toContain(
      "owner token minted for selftest (not printed; revoked at end of run)",
    );
    expect(line(w, "selftest").data.mcp).toBe("ok");
    expect(w.files.has(STATE)).toBe(false);
    expect(w.db.tokens.map((t) => t.label)).toEqual(["setup-ci"]);
  });

  it("revokes the minted token after a successful selftest", async () => {
    const w = world();
    expect(await run(CI, w.deps, ROOT)).toBe(0);
    const last = parsed(w).at(-1);
    expect(last).toMatchObject({ step: "revoke-ci-token", status: "ok" });
    expect(revokes(w)).toHaveLength(1);
    expect(w.db.tokens[0].revoked_at).toBeGreaterThan(0);
    expect(w.sqls.findIndex((s) => REVOKE.test(s))).toBe(w.sqls.length - 1);
  });

  it("revokes even when selftest fails", async () => {
    const w = world({ noPublishTool: true });
    expect(await run(CI, w.deps, ROOT)).toBe(1);
    expect(line(w, "selftest").status).toBe("error");
    expect(parsed(w).at(-1)).toMatchObject({
      step: "revoke-ci-token",
      status: "ok",
    });
    expect(w.db.tokens[0].revoked_at).toBeGreaterThan(0);
    noPat(w);
  });

  it("a failed revocation exits non-zero and names the token id, not the token", async () => {
    const w = world({
      failOn: /^UPDATE tokens SET revoked_at = \d+ WHERE id =/,
    });
    const code = await run(CI, w.deps, ROOT);
    expect(code).not.toBe(0);
    const l = parsed(w).at(-1);
    expect(l).toMatchObject({ step: "revoke-ci-token", status: "error" });
    expect(l.message).toContain(w.db.tokens[0].id);
    expect(l.message).toContain("Settings");
    noPat(w);
  });

  it("agent-config carries no token and points to the dashboard", async () => {
    const w = world();
    expect(await run(CI, w.deps, ROOT)).toBe(0);
    const d = line(w, "agent-config");
    expect(d.data.snippets.json).toContain("<YOUR_TOKEN>");
    expect(JSON.stringify(d)).toContain("Settings → Tokens");
    expect(JSON.stringify(d)).not.toContain("owner-token step");
  });

  it("human --ci output is json and leak-free too", async () => {
    const w = world();
    expect(await run(CI, w.deps, ROOT)).toBe(0);
    expect(w.prompts).toEqual([]);
  });

  it("without --name is an error", async () => {
    const w = world({ state: { name: "open-artifacts" } });
    const argv = CI.filter((a, i) => a !== "--name" && CI[i - 1] !== "--name");
    expect(await run(argv, w.deps, ROOT)).not.toBe(0);
    expect(parsed(w)[0].message).toContain("--ci requires --name");
    expect(w.creates).toEqual([]);
  });

  it("with --new-owner-token is an error", async () => {
    const w = world();
    expect(await run([...CI, "--new-owner-token"], w.deps, ROOT)).toBe(1);
    expect(parsed(w)[0].message).toContain("--new-owner-token");
  });

  it("an existing state file is left untouched", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    const before = w.files.get(STATE);
    w.lines.length = 0;
    expect(await run(CI, w.deps, ROOT)).toBe(0);
    expect(w.files.get(STATE)).toBe(before);
  });
});
