import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HELP, run } from "../src/index.ts";
import { ROOT } from "./fakes.ts";
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
    expect(line(w, "deploy")).toMatchObject({
      status: "action_required",
      message: MESSAGE("0.1.0", "0.2.0"),
    });
    expect(w.ops).toEqual([]);
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
    expect(line(w, "deploy").message).toBe(MESSAGE("0.1.0", "0.3.0"));
  });

  it("compares numerically, not as strings", async () => {
    const o: Opts = {};
    const w = await installed("0.9.0", o);
    o.healthVersion = "0.10.0";
    expect(await run(UP, w.deps, ROOT)).toBe(2);
  });

  it("healthz down: falls back to the saved deployed version", async () => {
    const o: Opts = { healthzDown: true };
    const w = await installed("0.0.5", o);
    expect(w.state().deployedVersion).toBe("0.1.0");
    expect(await run(UP, w.deps, ROOT)).toBe(2);
    expect(line(w, "deploy").message).toBe(MESSAGE("0.0.5", "0.1.0"));
  });

  it("nothing known: no guard, with a note", async () => {
    const w = world({ healthzDown: true });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(line(w, "deploy").message).toContain("no version guard");
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
