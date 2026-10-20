import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HELP, run } from "../src/index.ts";
import { ROOT, STATE } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

type Opts = NonNullable<Parameters<typeof world>[0]>;
type W = ReturnType<typeof world>;
const parse = (w: W) => w.lines.map((l) => JSON.parse(l));
const line = (w: W, step: string) => parse(w).find((j) => j.step === step);
const PKG = join(ROOT, "package.json");
const MESSAGE = (repo: string, live: string) =>
  `this checkout is ${repo}, older than the deployed ${live}; check out ${live} or newer (git checkout v${live}), or pass --allow-downgrade to deploy an older release on purpose`;

/** An installed world (state.deployedVersion 0.1.0), then the checkout set to `repo`. */
async function installed(repo: string, o: Opts = {}) {
  const w = world(o);
  expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
  w.files.set(PKG, JSON.stringify({ name: "open-artifacts", version: repo }));
  w.lines.length = 0;
  w.ops.length = 0;
  return w;
}
const UP = [...HOSTS, "--upgrade"];

describe("downgrade guard", () => {
  it("documents --allow-downgrade", () => {
    expect(HELP).toContain("--allow-downgrade");
  });

  it("an older checkout is blocked with exit 2 before migrations and deploy", async () => {
    const o: Opts = {};
    const w = await installed("0.1.0", o);
    o.healthVersion = "0.2.0";
    expect(await run(UP, w.deps, ROOT)).toBe(2);
    expect(line(w, "prereqs")).toMatchObject({
      status: "action_required",
      message: MESSAGE("0.1.0", "0.2.0"),
    });
    expect(w.ops).toEqual([]);
  });

  it("#7: --yes-paid does not bypass the downgrade guard", async () => {
    const o: Opts = {};
    const w = await installed("0.1.0", o);
    o.healthVersion = "0.2.0";
    expect(await run([...UP, "--yes-paid"], w.deps, ROOT)).toBe(2);
    expect(line(w, "prereqs")).toMatchObject({
      status: "action_required",
      message: MESSAGE("0.1.0", "0.2.0"),
    });
    expect(w.ops).toEqual([]);
    w.lines.length = 0;
    expect(
      await run([...UP, "--yes-paid", "--allow-downgrade"], w.deps, ROOT),
    ).toBe(0);
  });

  it("--allow-downgrade proceeds with a note", async () => {
    const o: Opts = {};
    const w = await installed("0.1.0", o);
    o.healthVersion = "0.2.0";
    expect(await run([...UP, "--allow-downgrade"], w.deps, ROOT)).toBe(0);
    expect(line(w, "deploy").message).toContain(
      "downgrading 0.2.0 → 0.1.0; D1 is not rolled back",
    );
    expect(w.ops).toContain("deploy");
  });

  it.each(["0.1.0", "0.0.9"])(
    "a live %s is equal or older: proceeds",
    async (live) => {
      const o: Opts = {};
      const w = await installed("0.1.0", o);
      o.healthVersion = live;
      expect(await run(UP, w.deps, ROOT)).toBe(0);
      expect(w.ops).toContain("deploy");
    },
  );

  it("compares a -dev+sha live version on its base", async () => {
    const o: Opts = {};
    const w = await installed("0.1.0", o);
    o.healthVersion = "0.1.0-dev+abc123";
    expect(await run(UP, w.deps, ROOT)).toBe(0);
    o.healthVersion = "0.3.0-dev+abc123";
    w.lines.length = 0;
    expect(await run(UP, w.deps, ROOT)).toBe(2);
    expect(line(w, "prereqs").message).toBe(MESSAGE("0.1.0", "0.3.0"));
  });

  it("compares numerically, not as strings", async () => {
    const o: Opts = {};
    const w = await installed("0.9.0", o);
    o.healthVersion = "0.10.0";
    expect(await run(UP, w.deps, ROOT)).toBe(2);
  });

  it("healthz down: falls back to the saved deployed version", async () => {
    const o: Opts = {};
    const w = await installed("0.0.5", o);
    o.healthzDown = true;
    expect(w.state().deployedVersion).toBe("0.1.0");
    expect(await run(UP, w.deps, ROOT)).toBe(2);
    expect(line(w, "prereqs").message).toBe(MESSAGE("0.0.5", "0.1.0"));
  });

  it("a fresh install makes no healthz request and adds no note", async () => {
    const w = world({ healthVersion: "9.9.9" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.hits.filter((h) => h === "GET /healthz")).toHaveLength(1);
    expect(line(w, "deploy").message).not.toContain("guard");
  });

  it("--upgrade with a rebuilt state (no deployedVersion) is guarded", async () => {
    const o: Opts = {};
    const w = await installed("0.1.0", o);
    const { deployedVersion: _, ...st } = w.state();
    w.files.set(STATE, JSON.stringify({ name: st.name }));
    o.healthVersion = "0.2.0";
    expect(await run(UP, w.deps, ROOT)).toBe(2);
    expect(line(w, "prereqs").message).toBe(MESSAGE("0.1.0", "0.2.0"));
    expect(w.ops).toEqual([]);
  });

  it("--ci with no state is not guarded", async () => {
    const w = world({ healthVersion: "9.9.9" });
    const ci = HOSTS.filter((a) => a !== "--yes");
    expect(await run([...ci, "--ci"], w.deps, ROOT)).toBe(0);
  });

  it("a full setup of an older checkout stops before any write", async () => {
    const o: Opts = {};
    const w = await installed("0.1.0", o);
    o.healthVersion = "0.2.0";
    const writes: string[] = [];
    const f = w.deps.fetch;
    w.deps.fetch = async (i, init) => {
      if ((init?.method ?? "GET") !== "GET") writes.push(String(i));
      return f(i, init);
    };
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    expect(parse(w).map((j) => `${j.step}:${j.status}`)).toEqual([
      "prereqs:action_required",
    ]);
    expect(writes).toEqual([]);
    expect(w.ops).toEqual([]);
  });

  it("an unparseable checkout version is an error, not a disabled guard", async () => {
    const w = await installed("banana");
    expect(await run(UP, w.deps, ROOT)).toBe(1);
    expect(line(w, "prereqs")).toMatchObject({ status: "error" });
    expect(line(w, "prereqs").message).toContain(
      "cannot read this checkout's version",
    );
    expect(w.ops).toEqual([]);
  });

  it.each([
    ["an HTML (Access login) body", { healthzBody: "<html>Sign in</html>" }],
    ["a garbage version", { healthVersion: "not-a-version" }],
  ])("%s falls back to the saved version", async (_n, flip) => {
    const o: Opts = {};
    const w = await installed("0.0.5", o);
    Object.assign(o, flip);
    expect(await run(UP, w.deps, ROOT)).toBe(2);
    expect(line(w, "prereqs").message).toBe(MESSAGE("0.0.5", "0.1.0"));
  });

  it("a v-prefixed live version is read", async () => {
    const o: Opts = {};
    const w = await installed("0.1.0", o);
    o.healthVersion = "v0.3.0";
    expect(await run(UP, w.deps, ROOT)).toBe(2);
    expect(line(w, "prereqs").message).toBe(MESSAGE("0.1.0", "0.3.0"));
  });

  it("0.10.0 over a live 0.9.0 proceeds", async () => {
    const o: Opts = {};
    const w = await installed("0.10.0", o);
    o.healthVersion = "0.9.0";
    expect(await run(UP, w.deps, ROOT)).toBe(0);
  });

  it("--check reports the comparison and never blocks", async () => {
    const o: Opts = {};
    const w = await installed("0.1.0", o);
    o.healthVersion = "0.2.0";
    expect(await run([...HOSTS, "--check"], w.deps, ROOT)).toBe(0);
    expect(line(w, "deploy").data).toEqual({
      repoVersion: "0.1.0",
      liveVersion: "0.2.0",
      downgrade: true,
    });
    expect(w.ops).toEqual([]);
  });
});
