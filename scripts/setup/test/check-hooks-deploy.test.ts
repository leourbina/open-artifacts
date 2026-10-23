import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { ROOT } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

// T3b L10: with OA_CHECK_NO_TEST_HOOKS=1 (deploy-prod's upgrade step), the
// deploy step runs check-no-test-hooks on a dry-run build of the exact config
// and sources it is about to `wrangler deploy`, and refuses on failure.
describe("deploy: check-no-test-hooks on the bundle to deploy", () => {
  const dryRunDir = (ops: string[]) =>
    ops.find((o) => o.startsWith("check-no-test-hooks "))?.slice(20);

  it("off by default: no check", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.ops.some((o) => o.startsWith("check-no-test-hooks"))).toBe(false);
    expect(w.ops).toContain("deploy");
  });

  it("on: checks a dry-run outdir right before the deploy", async () => {
    const w = world({ env: { OA_CHECK_NO_TEST_HOOKS: "1" } });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    const at = w.ops.findIndex((o) => o.startsWith("check-no-test-hooks "));
    expect(at).toBeGreaterThan(-1);
    expect(w.ops.indexOf("deploy")).toBeGreaterThan(at);
    const dir = dryRunDir(w.ops) as string;
    expect(
      w.argv.some((a) => a.includes(`deploy --dry-run --outdir ${dir}`)),
    ).toBe(true);
  });

  it("a failing check refuses the deploy", async () => {
    const w = world({
      env: { OA_CHECK_NO_TEST_HOOKS: "1" },
      checkHooksFails: true,
    });
    expect(await run(HOSTS, w.deps, ROOT)).not.toBe(0);
    expect(w.ops).not.toContain("deploy");
    expect(w.execOut.join("\n") + w.lines.join("\n")).toMatch(
      /check-no-test-hooks/,
    );
  });
});
