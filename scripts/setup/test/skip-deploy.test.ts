import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { ROOT } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

type W = ReturnType<typeof world>;
type Opts = NonNullable<Parameters<typeof world>[0]>;
const PKG = join(ROOT, "package.json");
const line = (w: W, s: string) =>
  w.lines.map((l) => JSON.parse(l)).find((j) => j.step === s);
const deploys = (w: W) => w.ops.filter((o) => o === "deploy").length;
const installed = async (o: Opts = {}) => {
  const opts: Opts = { stableBundle: "bundle-v1", ...o };
  const w = world(opts);
  expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
  w.lines.length = 0;
  w.ops.length = 0;
  return { w, opts };
};

describe("#25: an identical deploy is skipped", () => {
  it("a rerun with the same config, version and bundle skips wrangler deploy (status skipped) but still migrates", async () => {
    const { w } = await installed();
    const before = w.state();
    expect(before.deployHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(deploys(w)).toBe(0);
    expect(w.ops).toContain("migrate open-artifacts");
    const l = line(w, "deploy");
    expect(l.status).toBe("skipped");
    expect(l.message).toContain("already deployed 0.1.0");
    expect(l.data.deploySkipped).toBe(true);
    expect(w.state().workerVersion).toBe(before.workerVersion);
    expect(w.state().previousWorkerVersion).toBe(before.previousWorkerVersion);
  });

  it("--upgrade with the same version and config is a no-op deploy", async () => {
    const { w } = await installed();
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(deploys(w)).toBe(0);
    expect(w.ops).toContain("migrate open-artifacts");
  });

  it("the hash covers the real built bundle: a changed dry-run output deploys again", async () => {
    const { w, opts } = await installed();
    // @oa/shared, dependencies and the lockfile are all inside the bundle, so any change shows here
    const w2 = world({
      ...opts,
      stableBundle: "bundle-v2",
      files: Object.fromEntries(w.files),
    });
    expect(await run(HOSTS, w2.deps, ROOT)).toBe(0);
    expect(deploys(w2)).toBe(1);
  });

  it("a changed repo version deploys again", async () => {
    const { w } = await installed();
    w.files.set(
      PKG,
      JSON.stringify({ name: "open-artifacts", version: "0.1.1" }),
    );
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(deploys(w)).toBe(1);
  });

  it("a changed rendered config deploys again", async () => {
    const { w } = await installed();
    expect(await run([...HOSTS, "--plan", "paid"], w.deps, ROOT)).toBe(0);
    expect(deploys(w)).toBe(1);
  });

  it("a live version that isn't the one this install deployed deploys again", async () => {
    const { w } = await installed();
    const path = join(ROOT, ".openartifacts/state.json");
    const s = JSON.parse(w.files.get(path) ?? "{}");
    s.workerVersion = "someone-else";
    w.files.set(path, JSON.stringify(s));
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(deploys(w)).toBe(1);
  });

  it("never skips when the dry run fails", async () => {
    const { w } = await installed({ dryRunFails: true });
    expect(w.state().deployHash).toBeUndefined();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(deploys(w)).toBe(1);
  });

  it("never skips when two builds of the same source differ (non-deterministic bundle)", async () => {
    const { w } = await installed({ stableBundle: undefined });
    expect(w.state().deployHash).toBeUndefined();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(deploys(w)).toBe(1);
  });

  it("#25: --rollback clears the hash, so the next run deploys", async () => {
    const { w } = await installed();
    // a second real deploy so there is a previous version to roll back to
    w.files.set(
      PKG,
      JSON.stringify({ name: "open-artifacts", version: "0.1.1" }),
    );
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(deploys(w)).toBe(1);
    w.ops.length = 0;
    expect(await run([...HOSTS, "--rollback"], w.deps, ROOT)).toBe(0);
    expect(w.state().deployHash).toBeUndefined();
    w.ops.length = 0;
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(deploys(w)).toBe(1);
  });
});
