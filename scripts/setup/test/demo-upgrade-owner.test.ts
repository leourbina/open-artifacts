import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { ROOT } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

// The `prod-setup.sh demo-upgrade` flags, against a demo-style host pair.
const DEMO_HOSTS = {
  appHost: "demo.example.com",
  contentHost: "demo-content.example.com",
};
const DEMO = [
  ...["--name", "open-artifacts-demo"],
  ...["--app-host", DEMO_HOSTS.appHost],
  ...["--content-host", DEMO_HOSTS.contentHost],
  ...["--owner-email", "demo-owner@example.com"],
  ...["--ci", "--json", "--solo", "--no-email", "--yes-paid"],
];
type W = ReturnType<typeof world>;
const parsed = (w: W) => w.lines.map((l) => JSON.parse(l));
const line = (w: W, s: string) => parsed(w).find((j) => j.step === s);
const setupCi = (w: W) => w.db.tokens.filter((t) => t.label === "setup-ci");
const live = (w: W) => setupCi(w).filter((t) => !t.revoked_at);

async function demoInstalled() {
  const w = world(DEMO_HOSTS);
  expect(await run(DEMO, w.deps, ROOT)).toBe(0);
  w.lines.length = 0;
  w.sqls.length = 0;
  w.bearers.clear();
  return w;
}
const roles = (w: W) => w.db.users.map((u) => `${u.email}:${u.role}`).sort();

describe("demo-env --ci --upgrade owner check", () => {
  it("a routine demo upgrade passes: mints only a setup-ci token, changes no role, revokes it", async () => {
    const w = await demoInstalled();
    const rolesBefore = roles(w);
    const tokensBefore = w.db.tokens.length;
    expect(await run([...DEMO, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(roles(w)).toEqual(rolesBefore);
    expect(w.db.tokens).toHaveLength(tokensBefore + 1);
    expect(w.db.tokens.slice(tokensBefore).map((t) => t.label)).toEqual([
      "setup-ci",
    ]);
    expect(live(w)).toHaveLength(0);
    expect(w.sqls.join("\n")).not.toMatch(/SET role/);
    expect(line(w, "selftest").data.mcp).toBe("ok");
    expect(parsed(w).at(-1)).toMatchObject({
      step: "revoke-ci-token",
      status: "ok",
    });
  });

  it("a demo world whose owner row is missing fails with 'no user row' and mints nothing", async () => {
    const w = await demoInstalled();
    w.db.users.length = 0;
    const tokensBefore = w.db.tokens.length;
    expect(await run([...DEMO, "--upgrade"], w.deps, ROOT)).not.toBe(0);
    expect(JSON.stringify(parsed(w))).toContain("no user row");
    expect(w.db.tokens).toHaveLength(tokensBefore);
    expect(w.db.users).toHaveLength(0);
  });

  it("a demo world with a second owner fails with 'won't change ownership' and changes no role", async () => {
    const w = await demoInstalled();
    w.db.users.push({ id: "u2", email: "other@example.com", role: "owner" });
    const rolesBefore = roles(w);
    const tokensBefore = w.db.tokens.length;
    expect(await run([...DEMO, "--upgrade"], w.deps, ROOT)).not.toBe(0);
    expect(JSON.stringify(parsed(w))).toContain("won't change ownership");
    expect(roles(w)).toEqual(rolesBefore);
    expect(w.db.tokens).toHaveLength(tokensBefore);
  });

  it("routes the demo host in the fake; prod-style worlds are unaffected", async () => {
    const demo = world(DEMO_HOSTS);
    const hit = (u: string) => demo.deps.fetch(u).then((r) => r.status);
    expect(await hit("https://demo.example.com/healthz")).toBe(200);
    expect(await hit("https://app.example.com/healthz")).toBe(404);
    const prod = world();
    const phit = (u: string) => prod.deps.fetch(u).then((r) => r.status);
    expect(await phit("https://app.example.com/healthz")).toBe(200);
    expect(await phit("https://demo.example.com/healthz")).not.toBe(200);
    expect(HOSTS).toContain("app.example.com");
  });
});
