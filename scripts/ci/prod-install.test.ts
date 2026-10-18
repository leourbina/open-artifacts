import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sandbox, script } from "./stubs.ts";

const FAKE = `oa_pat_${"A".repeat(32)}`;
const ok = (step: string) => `{"step":"${step}","status":"ok"}`;

const install = (lines: string[], pnpmExit = 0) => {
  const body = `cat <<'EOF_FIXTURE'\n${lines.join("\n")}\nEOF_FIXTURE\nexit ${pnpmExit}`;
  const sb = sandbox({ pnpm: body });
  const summary = join(mkdtempSync(join(tmpdir(), "sum-")), "summary.md");
  const r = sb.run(["bash", script("prod-install.sh"), "--ci"], {
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

describe("prod-install.sh", () => {
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
});
