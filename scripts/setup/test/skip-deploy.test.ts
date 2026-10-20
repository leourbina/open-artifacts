import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { ROOT } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

type W = ReturnType<typeof world>;
const DIST = join(ROOT, "apps/server/dist-assets/index.html");
const PKG = join(ROOT, "package.json");
const line = (w: W, s: string) =>
  w.lines.map((l) => JSON.parse(l)).find((j) => j.step === s);
const deploys = (w: W) => w.ops.filter((o) => o === "deploy").length;
const installed = async (files: Record<string, string> = { [DIST]: "v1" }) => {
  const w = world({ files });
  expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
  w.lines.length = 0;
  w.ops.length = 0;
  return w;
};

describe("#25: an identical deploy is skipped", () => {
  it("a rerun with the same config, version and bundle skips wrangler deploy but still migrates", async () => {
    const w = await installed();
    const before = w.state();
    expect(before.deployHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(deploys(w)).toBe(0);
    expect(w.ops).toContain("migrate open-artifacts");
    expect(line(w, "deploy").message).toContain(
      "skipped: already deployed 0.1.0",
    );
    expect(line(w, "deploy").data.deploySkipped).toBe(true);
    expect(w.state().workerVersion).toBe(before.workerVersion);
    expect(w.state().previousWorkerVersion).toBe(before.previousWorkerVersion);
  });

  it("--upgrade with the same version and config is a no-op deploy", async () => {
    const w = await installed();
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(deploys(w)).toBe(0);
    expect(w.ops).toContain("migrate open-artifacts");
  });

  it("a changed bundle deploys again", async () => {
    const w = await installed();
    w.files.set(DIST, "v2");
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(deploys(w)).toBe(1);
    expect(line(w, "deploy").message).not.toContain("skipped");
  });

  it("a changed repo version deploys again", async () => {
    const w = await installed();
    w.files.set(
      PKG,
      JSON.stringify({ name: "open-artifacts", version: "0.1.1" }),
    );
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(deploys(w)).toBe(1);
  });

  it("a changed rendered config deploys again", async () => {
    const w = await installed();
    expect(await run([...HOSTS, "--plan", "paid"], w.deps, ROOT)).toBe(0);
    expect(deploys(w)).toBe(1);
  });

  it("a live version that isn't the one this install deployed deploys again", async () => {
    const w = await installed();
    const s = JSON.parse(
      w.files.get(join(ROOT, ".openartifacts/state.json")) ?? "{}",
    );
    s.workerVersion = "someone-else";
    w.files.set(join(ROOT, ".openartifacts/state.json"), JSON.stringify(s));
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(deploys(w)).toBe(1);
  });

  it("never skips when the hash is unknown (no built bundle to read)", async () => {
    const w = await installed({});
    expect(w.state().deployHash).toBeUndefined();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(deploys(w)).toBe(1);
  });
});
