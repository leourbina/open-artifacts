import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const w: any = parse(
  readFileSync(join(root, ".github/workflows/ops-demo-ops-deploy.yml"), "utf8"),
);
const job = w.jobs.deploy;
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const steps: any[] = job.steps;
const text = JSON.stringify(w);

describe("ops-demo-ops-deploy.yml", () => {
  it("is dispatch only, from main, on the demo group", () => {
    expect(Object.keys(w.on)).toEqual(["workflow_dispatch"]);
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(w.concurrency.group).toBe("demo-ops-deploy");
    expect(w.concurrency["cancel-in-progress"]).toBe(false);
  });
  it("uses only the staging-scoped token, account id and the demo PAT", () => {
    const names = new Set(
      [...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]),
    );
    expect([...names].sort()).toEqual([
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "DEMO_OA_TOKEN",
    ]);
  });
  it("scopes the Cloudflare token to the deploy steps only", () => {
    expect(w.env).toBeUndefined();
    expect(job.env).toBeUndefined();
    for (const s of steps) {
      const has = JSON.stringify(s.env ?? {}).includes("CLOUDFLARE_API_TOKEN");
      const wrangler = String(s.run ?? "").includes("wrangler");
      expect(has, s.name ?? s.run).toBe(wrangler);
    }
  });
  it("builds @oa/shared explicitly before the deploy step", () => {
    const run = steps.map((s) => String(s.run ?? ""));
    const iBuild = run.findIndex((r) =>
      r.includes("--filter @oa/shared build"),
    );
    const iDeploy = run.findIndex((r) => r.includes("wrangler deploy"));
    expect(iBuild).toBeGreaterThanOrEqual(0);
    expect(iBuild).toBeLessThan(iDeploy);
  });
  it("checks out without persisting credentials", () => {
    const co = steps.filter((s) =>
      String(s.uses ?? "").startsWith("actions/checkout"),
    );
    expect(co.length).toBeGreaterThan(0);
    for (const s of co) expect(s.with?.["persist-credentials"]).toBe(false);
  });
  it("deploys the demo-ops config", () => {
    expect(text).toContain("../demo-ops/wrangler.jsonc");
    expect(text).toMatch(/wrangler deploy/);
  });
  it("sets the secret by piping the GitHub secret on stdin", () => {
    const step = steps.find((s) =>
      String(s.run ?? "").includes("secret put DEMO_OA_TOKEN"),
    );
    expect(step.run).toMatch(/printf '%s' "\$DEMO_OA_TOKEN" \| .*secret put/);
    expect(step.run).not.toContain("secrets.");
    expect(step.run).not.toMatch(/echo/);
    expect(step.env.DEMO_OA_TOKEN).toContain("secrets.DEMO_OA_TOKEN");
  });
  it("runs both deploy and secret put", () => {
    const run = steps.map((s) => String(s.run ?? "")).join("\n");
    expect(run).toContain("wrangler deploy");
    expect(run).toContain("secret put");
  });
});
