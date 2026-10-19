import { describe, expect, it } from "vitest";
import { HELP, run } from "../src/index.ts";
import { ROOT } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

type W = ReturnType<typeof world>;
const parse = (w: W) => w.lines.map((l) => JSON.parse(l));
const last = (w: W) => parse(w).at(-1);
const ROLLBACK = ["--name", "open-artifacts", "--json", "--rollback"];

/** Install, then upgrade once: state holds ver-2 with ver-1 as the previous. */
async function twice(o: Parameters<typeof world>[0] = {}) {
  const w = world(o);
  expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
  expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
  w.lines.length = 0;
  w.ops.length = 0;
  return w;
}

describe("deploy records the Worker version it replaces", () => {
  it("first install: workerVersion set, previous unset", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    const st = w.state();
    expect(st.workerVersion).toBe("ver-1");
    expect(st.previousWorkerVersion).toBeUndefined();
  });

  it("an upgrade records the replaced version as previous", async () => {
    const w = await twice();
    const st = w.state();
    expect(st.workerVersion).toBe("ver-2");
    expect(st.previousWorkerVersion).toBe("ver-1");
  });

  it("a live Worker's version is recorded as previous", async () => {
    const w = world({ workerVersion: "live-0", worker: { APP_HOST: "x" } });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.state().previousWorkerVersion).toBe("live-0");
  });

  it("a failed deploy records neither", async () => {
    const w = world({ workerVersion: "live-0", deployFails: "boom" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    const st = w.state();
    expect(st.workerVersion).toBeUndefined();
    expect(st.previousWorkerVersion).toBeUndefined();
  });

  it("an unreadable version only warns; the deploy still succeeds", async () => {
    const w = world({ deploymentsFail: true });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.state().previousWorkerVersion).toBeUndefined();
    expect(w.lines.join("\n")).toContain(
      "could not read the live Worker version",
    );
  });

  it("--check and --json report both ids", async () => {
    const w = await twice();
    expect(await run([...HOSTS, "--check"], w.deps, ROOT)).toBe(0);
    expect(last(w).data).toMatchObject({
      workerVersion: "ver-2",
      previousWorkerVersion: "ver-1",
    });
  });
});

describe("--rollback", () => {
  it("documents itself, D1 included", () => {
    expect(HELP).toContain("--rollback");
    expect(HELP).toMatch(/never touches D1/i);
  });

  it("rolls back, runs nothing else, and swaps the state", async () => {
    const w = await twice();
    expect(await run(ROLLBACK, w.deps, ROOT)).toBe(0);
    expect(parse(w)).toEqual([
      {
        step: "rollback",
        status: "ok",
        message: expect.any(String),
        data: { from: "ver-2", to: "ver-1" },
      },
    ]);
    expect(w.ops).toEqual(["rollback ver-1"]);
    expect(w.argv.at(-1)).toContain(
      "rollback ver-1 --message oa:setup --rollback -y",
    );
    expect(w.state()).toMatchObject({
      workerVersion: "ver-1",
      previousWorkerVersion: "ver-2",
    });
    // A second rollback undoes the first.
    w.lines.length = 0;
    expect(await run(ROLLBACK, w.deps, ROOT)).toBe(0);
    expect(last(w).data).toEqual({ from: "ver-1", to: "ver-2" });
    expect(w.state()).toMatchObject({
      workerVersion: "ver-2",
      previousWorkerVersion: "ver-1",
    });
  });

  it("with no previous version: exit 2, action_required, dashboard hint", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    w.lines.length = 0;
    w.ops.length = 0;
    expect(await run(ROLLBACK, w.deps, ROOT)).toBe(2);
    const l = last(w);
    expect(l).toMatchObject({ step: "rollback", status: "action_required" });
    expect(l.message).toMatch(/no previous version/i);
    expect(l.message).toContain("Workers → open-artifacts → Deployments");
    expect(w.ops).toEqual([]);
  });

  it("a wrangler failure: exit 1, error, no token in the output", async () => {
    const token = "cf-secret-token-123";
    const w = await twice({
      env: { CLOUDFLARE_API_TOKEN: token },
      rollbackFails: `bad request, Authorization: Bearer ${token} oa_pat_abc123`,
    });
    const before = w.state();
    expect(await run(ROLLBACK, w.deps, ROOT)).toBe(1);
    expect(last(w)).toMatchObject({ step: "rollback", status: "error" });
    expect(last(w).message).toContain("bad request");
    const out = w.lines.join("\n");
    expect(out).not.toContain(token);
    expect(out).not.toContain("oa_pat_abc123");
    expect(w.state()).toEqual(before);
  });

  it.each(["--upgrade", "--check", "--ci"])(
    "combined with %s is a usage error",
    async (flag) => {
      const w = await twice();
      expect(await run([...ROLLBACK, flag], w.deps, ROOT)).toBe(1);
      expect(last(w)).toMatchObject({ step: "args", status: "error" });
      expect(last(w).message).toContain("--rollback");
      expect(w.ops).toEqual([]);
    },
  );
});
