import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { ROOT, STATE } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

type W = ReturnType<typeof world>;
const access = (w: W) =>
  w.lines.map((l) => JSON.parse(l)).find((j) => j.step === "access");
const installed = async () => {
  const opts: NonNullable<Parameters<typeof world>[0]> = {};
  const w = world(opts);
  expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
  w.lines.length = 0;
  // CI is stateless: the app id is known only from the live Worker's vars.
  w.files.delete(STATE);
  return { w, opts };
};
const NOTE = (s: number) =>
  `Access API unavailable (${s}); verified from saved state only (upgrade never changes Access)`;

describe("Access API outage (5xx)", () => {
  it("--upgrade with a known Access app (the live Worker's ACCESS_* vars): a 504 is a note and the step is done", async () => {
    const { w, opts } = await installed();
    opts.accessReadStatus = 504;
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(access(w).status).not.toBe("error");
    expect(access(w).message).toContain(NOTE(504));
  });

  it("--upgrade --check is done with the note too, and nothing is written to Access", async () => {
    const { w, opts } = await installed();
    opts.accessReadStatus = 504;
    w.ops.length = 0;
    expect(
      await run([...HOSTS, "--upgrade", "--check"], w.deps, ROOT),
    ).not.toBe(1);
    expect(access(w).status).toBe("done");
    expect(access(w).message).toContain(NOTE(504));
    expect(w.ops.filter((o) => /access/i.test(o))).toEqual([]);
  });

  it("a full setup (no --upgrade) still fails on a 504", async () => {
    const { w, opts } = await installed();
    opts.accessReadStatus = 504;
    expect(await run(HOSTS, w.deps, ROOT)).not.toBe(0);
    expect(access(w).message).not.toContain("Access API unavailable");
  });

  it("a 4xx (403) under --upgrade stays an error or action_required", async () => {
    const { w, opts } = await installed();
    opts.accessReadStatus = 403;
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).not.toBe(0);
    expect(access(w).message).not.toContain("Access API unavailable");
  });

  it("under --upgrade, state with the app id and a changed host still tolerates a 504", async () => {
    const { w, opts } = await installed();
    w.files.set(
      STATE,
      JSON.stringify({
        name: "open-artifacts",
        accountId: "acc1",
        appHost: "old.example.com",
        accessAppId: "app1",
        accessClientId: "cid",
        teamDomain: "team.cloudflareaccess.com",
      }),
    );
    opts.accessReadStatus = 504;
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(access(w).message).toContain(NOTE(504));
  });

  it("with no saved app id (and none on the Worker) a 504 stays an error", async () => {
    const w = world({ accessReadStatus: 504 });
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).not.toBe(0);
    expect(access(w)?.message ?? "").not.toContain("Access API unavailable");
  });
});
