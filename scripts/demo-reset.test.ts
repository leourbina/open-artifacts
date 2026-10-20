import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseSeed } from "./demo/reset.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const w: any = parse(read(".github/workflows/demo-reset.yml"));
const job = w.jobs.reset;
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const steps: any[] = job.steps;

describe("demo-reset.yml", () => {
  it("runs daily at 04:00 UTC and on dispatch", () => {
    expect(w.on.schedule).toEqual([{ cron: "0 4 * * *" }]);
    expect(Object.keys(w.on)).toContain("workflow_dispatch");
  });
  it("serializes on the demo group, only when DEMO_ENABLED, from main", () => {
    expect(w.concurrency.group).toBe("demo-reset");
    expect(w.concurrency["cancel-in-progress"]).toBe(false);
    expect(job.if).toContain("vars.DEMO_ENABLED == 'true'");
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
  });
  it("uses only the DEMO_OA_TOKEN secret", () => {
    const names = [...JSON.stringify(w).matchAll(/secrets\.([A-Za-z0-9_]+)/g)];
    expect(names.map((m) => m[1])).toEqual(["DEMO_OA_TOKEN"]);
  });
  it("writes the PAT with umask 077 via printf, never echoed", () => {
    const step = steps.find((s) => String(s.run ?? "").includes("printf"));
    expect(step.run).toContain("umask 077");
    expect(step.run).toContain('"$RUNNER_TEMP/pat"');
    expect(step.run).not.toMatch(/echo/);
    expect(step.run).not.toContain("secrets.");
    expect(step.env.DEMO_OA_TOKEN).toContain("secrets.DEMO_OA_TOKEN");
  });
  it("applies the seed with the exact reset invocation", () => {
    const run = steps
      .map((s) => String(s.run ?? ""))
      .join("\n")
      .replace(/\s+/g, " ");
    expect(run).toContain(
      'scripts/demo/reset.ts --base-url https://demo.open-artifacts.com --token-file "$RUNNER_TEMP/pat" ops/demo/seed.json --apply',
    );
  });
  it("checks healthz after the reset", () => {
    const iReset = steps.findIndex((s) =>
      String(s.run ?? "").includes("reset.ts"),
    );
    const iHealth = steps.findIndex((s) =>
      String(s.run ?? "").includes("https://demo.open-artifacts.com/healthz"),
    );
    expect(iHealth).toBeGreaterThan(iReset);
  });
  it("removes the PAT file even on failure", () => {
    const last = steps[steps.length - 1];
    expect(last.if).toBe("always()");
    expect(last.run).toContain("pat");
  });
});

describe("ops/demo/seed.json", () => {
  it("parses with the real reset.ts parseSeed (placeholder: no artifacts yet)", () => {
    const seed = parseSeed(read("ops/demo/seed.json"));
    expect(seed).toEqual({});
  });
});
