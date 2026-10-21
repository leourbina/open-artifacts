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
