import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildSeed } from "./demo/publish.js";
import { parseSeed } from "./demo/reset.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const w: any = parse(read(".github/workflows/demo-reset.yml"));
const job = w.jobs.reset;
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const steps: any[] = job.steps;

describe("demo-reset.yml", () => {
  it("runs daily at 23:59 UTC (clearing the finished day) and on dispatch", () => {
    expect(w.on.schedule).toEqual([{ cron: "59 23 * * *" }]);
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
      'scripts/demo/reset.ts --base-url https://demo.open-artifacts.com --token-file "$RUNNER_TEMP/pat" "$RUNNER_TEMP/seed.json" --apply',
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

describe("demo-reset.yml checkout", () => {
  it("does not persist credentials", () => {
    const co = steps.filter((s) =>
      String(s.uses ?? "").startsWith("actions/checkout"),
    );
    expect(co.length).toBeGreaterThan(0);
    for (const s of co) expect(s.with?.["persist-credentials"]).toBe(false);
  });
});

describe("the reset seed has one source of truth", () => {
  it("builds the seed from the per-slug seeds before resetting", () => {
    const iBuild = steps.findIndex((s) =>
      String(s.run ?? "").includes(
        'scripts/demo/publish.ts --write-seed "$RUNNER_TEMP/seed.json"',
      ),
    );
    const iReset = steps.findIndex((s) =>
      String(s.run ?? "").includes("reset.ts"),
    );
    expect(iBuild).toBeGreaterThanOrEqual(0);
    expect(iBuild).toBeLessThan(iReset);
  });
  it("has no committed ops/demo/seed.json and never references one", () => {
    expect(existsSync(join(root, "ops/demo/seed.json"))).toBe(false);
    expect(JSON.stringify(w)).not.toContain("ops/demo/seed.json");
  });
  // ops/demo arrives with Design's artifacts; until then there is nothing to build from.
  it.skipIf(!existsSync(join(root, "ops/demo/publish.json")))(
    "the generated seed parses with the real parseSeed",
    () => {
      expect(() =>
        parseSeed(JSON.stringify(buildSeed(join(root, "ops/demo")))),
      ).not.toThrow();
    },
  );
});
