import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const w: any = parse(
  readFileSync(join(root, ".github/workflows/demo-publish.yml"), "utf8"),
);
const job = w.jobs.publish;
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const steps: any[] = job.steps;
const run = (s: { run?: string }) => String(s.run ?? "");

describe("demo-publish.yml", () => {
  it("triggers on pushes to main touching ops/demo/**, and on dispatch", () => {
    expect(w.on.push.branches).toEqual(["main"]);
    expect(w.on.push.paths).toEqual(["ops/demo/**"]);
    expect(Object.keys(w.on).sort()).toEqual(["push", "workflow_dispatch"]);
  });
  it("runs only from main and only when DEMO_ENABLED", () => {
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(job.if).toContain("vars.DEMO_ENABLED == 'true'");
  });
  it("has read-only permissions and its own concurrency group", () => {
    expect(w.permissions).toEqual({ contents: "read" });
    expect(w.concurrency).toEqual({
      group: "demo-publish",
      "cancel-in-progress": false,
    });
  });
  it("uses only the DEMO_OA_TOKEN secret", () => {
    const names = [
      ...JSON.stringify(w).matchAll(
        /secrets(?:\.([A-Za-z0-9_]+)|\[\s*['"]([A-Za-z0-9_]+)['"]\s*\])/g,
      ),
    ].map((m) => m[1] ?? m[2]);
    expect(names).toEqual(["DEMO_OA_TOKEN"]);
  });
  it("writes the PAT with umask 077 via printf, never echoed or in argv", () => {
    const step = steps.find((s) => run(s).includes("printf"));
    expect(step.run).toContain("umask 077");
    expect(step.run).toContain('"$RUNNER_TEMP/pat"');
    expect(step.run).not.toMatch(/echo/);
    expect(step.env.DEMO_OA_TOKEN).toContain("secrets.DEMO_OA_TOKEN");
    for (const s of steps)
      if (s !== step) expect(JSON.stringify(s)).not.toContain("secrets.");
  });
  it("applies the publish with a token file, then checks healthz, then removes the PAT", () => {
    const iPub = steps.findIndex((s) =>
      run(s).includes("scripts/demo/publish.ts"),
    );
    const pub = run(steps[iPub]).replace(/\s+/g, " ");
    expect(pub).toContain("--base-url https://demo.open-artifacts.com");
    expect(pub).toContain('--token-file "$RUNNER_TEMP/pat"');
    expect(pub).toContain("--apply");
    const iHealth = steps.findIndex((s) =>
      run(s).includes("https://demo.open-artifacts.com/healthz"),
    );
    expect(iHealth).toBeGreaterThan(iPub);
    const last = steps[steps.length - 1];
    expect(last.if).toBe("always()");
    expect(last.run).toContain("pat");
  });
});
