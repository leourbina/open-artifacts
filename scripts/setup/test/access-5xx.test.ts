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
const NOTE = (s: number, from: string) =>
  `Access API unavailable (${s}); verified from ${from} only (upgrade never changes Access)`;
const saved = JSON.stringify({
  name: "open-artifacts",
  accountId: "acc1",
  appHost: "app.example.com",
  accessAppId: "app1",
  accessClientId: "cid-new",
  teamDomain: "team.cloudflareaccess.com",
});

describe("Access API outage (5xx)", () => {
  it("--upgrade with a known Access app (the live Worker's ACCESS_* vars): a 504 is a note and the step is done", async () => {
    const { w, opts } = await installed();
    opts.accessReadStatus = 504;
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(access(w).status).toBe("skipped");
    expect(access(w).message).toContain(NOTE(504, "the live Worker"));
  });

  it("a timeout or ECONNRESET is an outage too", async () => {
    for (const msg of [
      "request timed out",
      "read ECONNRESET",
      "fetch failed",
    ]) {
      const { w, opts } = await installed();
      opts.accessReadThrows = msg;
      expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
      expect(access(w).message).toContain("Access API unavailable (timeout)");
    }
  });

  it("an unrelated error is not an outage", async () => {
    const { w, opts } = await installed();
    opts.accessReadThrows = "bad json";
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).not.toBe(0);
    expect(access(w).message).not.toContain("Access API unavailable");
  });

  it("a missing ACCESS_CLIENT_SECRET during the outage is not tolerated", async () => {
    const { w, opts } = await installed();
    opts.accessReadStatus = 504;
    opts.hideSecrets = ["ACCESS_CLIENT_SECRET"];
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).not.toBe(0);
    expect(access(w).message).not.toContain("verified from");
  });

  it("the live Worker's hosts or owner must match the flags, as usual", async () => {
    for (const flag of [
      ["--app-host", "other.example.com"],
      ["--owner-email", "someone@else.example"],
    ]) {
      const { w, opts } = await installed();
      opts.accessReadStatus = 504;
      const argv = [...HOSTS];
      const i = argv.indexOf(flag[0] as string);
      argv[i + 1] = flag[1] as string;
      expect(await run([...argv, "--upgrade"], w.deps, ROOT)).not.toBe(0);
      expect(access(w).message).toMatch(/differs in/);
    }
  });

  it("a live team domain that is not <team>.cloudflareaccess.com is not trusted", async () => {
    const { w, opts } = await installed();
    opts.accessReadStatus = 504;
    opts.workerBindings = [
      {
        type: "plain_text",
        name: "ACCESS_TEAM_DOMAIN",
        text: "evil.example.com",
      },
    ];
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).not.toBe(0);
    expect(access(w).message).not.toContain("verified from");
  });

  it("--upgrade --check is done with the note too, and nothing is written to Access", async () => {
    const { w, opts } = await installed();
    opts.accessReadStatus = 504;
    w.ops.length = 0;
    expect(await run([...HOSTS, "--upgrade", "--check"], w.deps, ROOT)).toBe(0);
    expect(access(w).status).toBe("done");
    expect(access(w).message).toContain(NOTE(504, "the live Worker"));
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

  it("saved state for another host: an outage is an error, not a pass", async () => {
    const { w, opts } = await installed();
    w.files.set(STATE, saved.replace("app.example.com", "old.example.com"));
    opts.accessReadStatus = 504;
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(1);
    expect(access(w).message).toContain(
      "Access API unavailable; can't verify the new host's callback; retry later",
    );
  });

  it("with no saved app id (and none on the Worker) a 504 stays an error", async () => {
    const w = world({ accessReadStatus: 504 });
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).not.toBe(0);
    expect(access(w)?.message ?? "").not.toContain("Access API unavailable");
  });
});
