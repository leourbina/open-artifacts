import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sandbox, script } from "./stubs.ts";

const FAKE = `oa_pat_${"A".repeat(32)}`;
const ok = (step: string) => `{"step":"${step}","status":"ok"}`;

const install = (lines: string[], pnpmExit = 0, mode = "install") => {
  const body = `cat <<'EOF_FIXTURE'\n${lines.join("\n")}\nEOF_FIXTURE\nexit ${pnpmExit}`;
  const sb = sandbox({ pnpm: body });
  const summary = join(mkdtempSync(join(tmpdir(), "sum-")), "summary.md");
  const r = sb.run(["bash", script("prod-setup.sh"), mode], {
    env: {
      GITHUB_STEP_SUMMARY: summary,
      PROD_NAME: "open-artifacts-prod",
      PROD_APP_HOST: "app.example.com",
      PROD_CONTENT_HOST: "content.example.com",
      PROD_OWNER_EMAIL: "o@example.com",
    },
  });
  let sum = "";
  try {
    sum = readFileSync(summary, "utf8");
  } catch {}
  return { ...r, sum, calls: sb.log() };
};

describe("prod-setup.sh", () => {
  it("exits 0 and writes the summary when all steps are ok", () => {
    const r = install([ok("preflight"), ok("deploy"), ok("selftest")]);
    expect(r.code).toBe(0);
    expect(r.sum).toContain("| deploy | ok |");
    expect(r.calls[0]).toContain("--ci");
    expect(r.calls[0]).toContain("--app-host app.example.com");
  });
  it("fails on an action_required line", () => {
    const r = install([
      ok("preflight"),
      `{"step":"dns","status":"action_required"}`,
    ]);
    expect(r.code).not.toBe(0);
    expect(r.sum).toContain("| dns | action_required |");
  });
  it("fails on an error line", () => {
    expect(install([`{"step":"x","status":"error"}`]).code).not.toBe(0);
  });
  it("fails on a token pattern and never echoes it", () => {
    const r = install([ok("a"), `{"step":"b","status":"ok","note":"${FAKE}"}`]);
    expect(r.code).not.toBe(0);
    expect(r.out + r.err + r.sum).not.toContain(FAKE);
    expect(r.out + r.err).toContain("token pattern found in output; aborting");
  });
  it("fails when setup exits non-zero", () => {
    expect(install([ok("a")], 1).code).not.toBe(0);
  });
  it("rejects an unknown mode without running setup", () => {
    const r = install([ok("a")], 0, "bogus");
    expect(r.code).toBe(2);
    expect(r.calls).toEqual([]);
  });

  describe("deploy sequence (as the workflow runs it)", () => {
    // Mirrors the job: later steps skip after a failure, cleanup always runs.
    const sequence = (preflightFails: boolean) => {
      const sb = sandbox({
        pnpm: `case "$*" in *--check*) ${
          preflightFails
            ? `echo '{"step":"resources","status":"todo"}'; exit 2`
            : `echo '{"step":"resources","status":"done"}'`
        };; *) echo '{"step":"x","status":"ok"}';; esac`,
      });
      const env = {
        GITHUB_STEP_SUMMARY: join(sb.dir, "sum.md"),
        PROD_NAME: "open-artifacts-prod",
        PROD_APP_HOST: "app.example.com",
        PROD_CONTENT_HOST: "content.example.com",
        PROD_OWNER_EMAIL: "o@example.com",
      };
      const run = (m: string) =>
        sb.run(["bash", script("prod-setup.sh"), m], { env });
      const pre = run("preflight");
      const up = pre.code === 0 ? run("upgrade") : undefined;
      const clean = run("cleanup");
      return { pre, up, clean, calls: sb.log() };
    };
    it("preflight failure: upgrade is not run, cleanup still runs", () => {
      const r = sequence(true);
      expect(r.pre.code).not.toBe(0);
      expect(r.up).toBeUndefined();
      expect(r.calls[0]).toContain("--check --strict --upgrade");
      expect(r.calls.some((c) => c.includes("--ci --upgrade"))).toBe(false);
      expect(r.calls.at(-1)).toContain("--revoke-ci-tokens");
      expect(r.clean.code).toBe(0);
    });
    it("preflight pass: upgrade runs with --ci, then cleanup", () => {
      const r = sequence(false);
      expect(r.pre.code).toBe(0);
      expect(r.up?.code).toBe(0);
      expect(r.calls[1]).toContain("--ci --upgrade");
      expect(r.calls[1]).not.toContain("--check");
      expect(r.calls[2]).toContain("--ci --revoke-ci-tokens");
    });
    it("install, preflight and upgrade pass --solo --browser; cleanup does not", () => {
      // Prod is Workers Paid, but stateless CI reads the plan as unknown and
      // --json never guesses team: both are explicit. No email flags yet.
      const r = sequence(false);
      for (const c of r.calls.slice(0, 2))
        expect(c).toContain("--solo --browser");
      expect(install([ok("a")]).calls[0]).toContain("--solo --browser");
      expect(r.calls[2]).not.toContain("--solo");
      expect(r.calls[2]).not.toContain("--browser");
      for (const c of r.calls)
        expect(c).not.toMatch(/--team|email-domain|yes-paid/);
    });
  });
});
