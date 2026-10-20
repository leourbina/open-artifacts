import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sandbox, script } from "./stubs.ts";

const FAKE = `oa_pat_${"A".repeat(32)}`;
const ok = (step: string) => `{"step":"${step}","status":"ok"}`;

const install = (
  lines: string[],
  pnpmExit = 0,
  mode = "install",
  extra: Record<string, string> = {},
) => {
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
      ...extra,
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
  it("passes ANALYTICS_TOKEN through env, never argv; aborts if it is echoed", () => {
    const a = "analytics-SECRET-value";
    const env = { ANALYTICS_TOKEN: a };
    const fine = install([ok("secrets")], 0, "install", env);
    expect(fine.code).toBe(0);
    expect(fine.calls.join("\n")).not.toContain(a);
    const r = install(
      [`{"step":"x","status":"ok","m":"${a}"}`],
      0,
      "install",
      env,
    );
    expect(r.code).not.toBe(0);
    expect(r.out + r.err + r.sum).not.toContain(a);
    expect(r.out + r.err).toContain("token pattern found in output; aborting");
  });
  it("aborts on a trimmed or untrimmed echo of ANALYTICS_TOKEN", () => {
    for (const [secret, echoed] of [
      ["abc123\n", "abc123"],
      ["  abc123 ", "abc123"],
      ["  abc123 ", "  abc123 "],
    ] as const) {
      const r = install([`{"step":"x","m":"${echoed}"}`], 0, "install", {
        ANALYTICS_TOKEN: secret,
      });
      expect(r.code, JSON.stringify(secret)).not.toBe(0);
      expect(r.out + r.sum).not.toContain("abc123");
    }
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
    it("install, preflight and upgrade pass --solo --browser --plan paid; cleanup does not", () => {
      // Prod is Workers Paid, but stateless CI reads the plan as unknown and
      // --json never guesses team: both are explicit. No email flags yet.
      const r = sequence(false);
      for (const c of r.calls.slice(0, 2))
        expect(c).toContain("--solo --browser --plan paid");
      expect(install([ok("a")]).calls[0]).toContain(
        "--solo --browser --plan paid",
      );
      expect(r.calls[2]).not.toContain("--solo");
      expect(r.calls[2]).not.toContain("--browser");
      for (const c of r.calls)
        expect(c).not.toMatch(/--team|email-domain|yes-paid/);
    });
  });
});

describe("prod-setup.sh demo modes", () => {
  const demoEnv = {
    DEMO_NAME: "open-artifacts-demo",
    DEMO_APP_HOST: "demo.example.com",
    DEMO_CONTENT_HOST: "demo-content.example.com",
    DEMO_OWNER_EMAIL: "o@example.com",
  };
  const run = (mode: string, lines: string[], env = demoEnv, exit = 0) => {
    const body = `cat <<'EOF_FIXTURE'\n${lines.join("\n")}\nEOF_FIXTURE\nexit ${exit}`;
    const sb = sandbox({ pnpm: body });
    const r = sb.run(["bash", script("prod-setup.sh"), mode], {
      env: { GITHUB_STEP_SUMMARY: join(sb.dir, "sum.md"), ...env },
    });
    return { ...r, calls: sb.log() };
  };
  it("demo-install runs the demo flags and hosts", () => {
    const r = run("demo-install", [ok("a")]);
    expect(r.code).toBe(0);
    const c = r.calls[0] as string;
    for (const f of [
      "--ci",
      "--json",
      "--solo",
      "--no-email",
      "--yes-paid",
      "--name open-artifacts-demo",
      "--app-host demo.example.com",
      "--content-host demo-content.example.com",
    ])
      expect(c, f).toContain(f);
    expect(c).not.toContain("--upgrade");
    expect(c).not.toContain("--browser");
  });
  it("demo-upgrade adds --upgrade; demo-cleanup revokes tokens", () => {
    expect(run("demo-upgrade", [ok("a")]).calls[0]).toContain("--upgrade");
    expect(run("demo-cleanup", [ok("a")]).calls[0]).toContain(
      "--revoke-ci-tokens",
    );
  });
  it("a fake PAT in the output fails the step and is never echoed", () => {
    for (const m of ["demo-install", "demo-upgrade", "demo-cleanup"]) {
      const r = run(m, [`{"step":"b","status":"ok","note":"${FAKE}"}`]);
      expect(r.code, m).not.toBe(0);
      expect(r.out + r.err).not.toContain(FAKE);
      expect(r.out + r.err).toContain(
        "token pattern found in output; aborting",
      );
    }
  });
  it("an error status fails the step", () => {
    expect(
      run("demo-install", [`{"step":"x","status":"error"}`]).code,
    ).not.toBe(0);
  });
  it("requires the DEMO_* values", () => {
    expect(run("demo-install", [ok("a")], {} as never).code).not.toBe(0);
  });
});
