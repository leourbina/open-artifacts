import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const wf = (name: string): any => parse(read(`.github/workflows/${name}`));
// `on` is a plain key in YAML 1.2 (yaml package), so no boolean coercion.
const triggers = (w: { on: Record<string, unknown> }) => Object.keys(w.on);

describe("ci.yml", () => {
  const w = wf("ci.yml");
  it("triggers on pull_request and push to main", () => {
    expect(triggers(w).sort()).toEqual([
      "pull_request",
      "push",
      "workflow_dispatch",
    ]);
    expect(w.on.push.branches).toEqual(["main"]);
    expect("workflow_dispatch" in w.on).toBe(true);
  });
  it("defines exactly the five required jobs", () => {
    expect(Object.keys(w.jobs).sort()).toEqual(
      ["build", "e2e", "lint", "test", "typecheck"].sort(),
    );
  });
  it("uses node from .nvmrc with pnpm cache", () => {
    const raw = read(".github/workflows/ci.yml");
    expect(raw).toContain("node-version-file: .nvmrc");
    expect(raw).toContain("cache: pnpm");
  });
});

describe("deploy-staging.yml", () => {
  const w = wf("deploy-staging.yml");
  // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
  type Step = any;
  const runs = (id: string): string[] =>
    w.jobs[id].steps.map((s: Step) => s.run ?? "");
  const idx = (id: string, needle: string) =>
    runs(id).findIndex((r) => r.includes(needle));
  it("triggers on push to main with serialized staging concurrency", () => {
    expect(triggers(w)).toEqual(["push"]);
    expect(w.on.push.branches).toEqual(["main"]);
    expect(w.concurrency).toEqual({
      group: "staging",
      "cancel-in-progress": false,
    });
  });
  it("has deploy then smoke jobs", () => {
    expect(Object.keys(w.jobs)).toEqual(["deploy", "smoke"]);
    expect(w.jobs.smoke.needs).toEqual(["deploy"]);
  });
  it("deploy steps run build -> migrate -> deploy in order", () => {
    const b = idx("deploy", "pnpm build");
    const m = idx("deploy", "d1 migrations apply open-artifacts-staging");
    const d = idx("deploy", "wrangler deploy");
    expect(b).toBeGreaterThan(-1);
    expect(m).toBeGreaterThan(b);
    expect(d).toBeGreaterThan(m);
    const migrate = runs("deploy")[m] as string;
    const deploy = runs("deploy")[d] as string;
    expect(migrate).toContain("--remote");
    for (const c of [migrate, deploy]) {
      expect(c).toContain("--env staging");
      expect(c).toContain("wrangler.staging.jsonc");
    }
  });
  it("ensures dashboard dist exists before wrangler deploy", () => {
    const e = idx("deploy", "mkdir -p apps/dashboard/dist");
    expect(e).toBeGreaterThan(idx("deploy", "pnpm build"));
    expect(e).toBeLessThan(idx("deploy", "wrangler deploy"));
    expect(runs("deploy")[e]).toContain("apps/dashboard/dist/index.html");
  });
  it("smoke checks robots on the content host", () => {
    const all = runs("smoke").join("\n");
    expect(all).toContain("staging-content.open-artifacts.com/robots.txt");
  });
  it("migrate, deploy and smoke are never skippable or tolerated", () => {
    for (const id of ["deploy", "smoke"]) {
      expect(w.jobs[id].if).toBeUndefined();
      expect(w.jobs[id]["continue-on-error"]).toBeUndefined();
      for (const st of w.jobs[id].steps) {
        expect(st.if).toBeUndefined();
        expect(st["continue-on-error"]).toBeUndefined();
        expect(st.run ?? "").not.toContain("|| true");
      }
    }
  });
  it("smoke checks healthz, robots and runs the smoke suite", () => {
    const all = runs("smoke").join("\n");
    expect(all).toContain("staging.open-artifacts.com/healthz");
    expect(all).toContain("--retry 20 --retry-delay 5 --retry-max-time 180");
    expect(all).not.toMatch(/\|\s*grep/);
    expect(all).toContain("/robots.txt");
    expect(all).toContain("noindex, nofollow");
    expect(all).toContain("Disallow: /");
    expect(all).toContain("@oa/server smoke");
  });
  it("uses Cloudflare secrets", () => {
    const raw = read(".github/workflows/deploy-staging.yml");
    expect(raw).toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(raw).toContain("secrets.CLOUDFLARE_ACCOUNT_ID");
  });
});

describe("landing-preview.yml", () => {
  const w = wf("landing-preview.yml");
  const raw = read(".github/workflows/landing-preview.yml");
  it("triggers on PRs touching apps/landing", () => {
    expect(triggers(w)).toEqual(["pull_request"]);
    expect(w.on.pull_request.paths).toEqual(["apps/landing/**"]);
  });
  it("skips fork PRs", () => {
    expect(w.jobs.preview.if).toBe(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
  });
  it("gates early and passes the URL via env", () => {
    // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
    const steps = w.jobs.preview.steps as any[];
    expect(steps.some((s) => s.id === "gate")).toBe(true);
    const install = steps.find((s) => (s.run ?? "").includes("pnpm install"));
    expect(install.if).toContain("steps.gate.outputs.present");
    const gh = steps.find((s) => s.uses?.startsWith("actions/github-script"));
    expect(gh.env.PREVIEW_URL).toBeDefined();
    expect(gh.with.script).toContain("process.env.PREVIEW_URL");
    expect(gh.with.script).not.toContain("${{");
    expect(raw).toContain("|| true");
  });
});

describe("release-please", () => {
  it("workflow triggers on push to main with write permissions", () => {
    const w = wf("release-please.yml");
    expect(triggers(w)).toEqual(["push"]);
    expect(w.on.push.branches).toEqual(["main"]);
    expect(w.permissions).toEqual({
      actions: "write",
      contents: "write",
      "pull-requests": "write",
    });
    expect(read(".github/workflows/release-please.yml")).toContain(
      "googleapis/release-please-action@v4",
    );
  });
  it("dispatches CI on the release branch and deploys the tag", () => {
    const raw = read(".github/workflows/release-please.yml");
    expect(raw).toContain("gh workflow run ci.yml");
    expect(raw).toContain("prs_created");
    expect(raw).toContain("headBranchName");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(raw).toContain("ref: ${{ needs.release-please.outputs.tag_name }}");
    const gate = wf("release-please.yml").jobs["deploy-landing"].steps;
    expect(JSON.stringify(gate)).toContain("steps.gate.outputs.present");
  });
  it("config is release-type node, manifest starts at 0.0.0", () => {
    const c = JSON.parse(read("release-please-config.json"));
    expect(c.packages["."]["release-type"]).toBe("node");
    expect(c.packages["."]["bump-minor-pre-major"]).toBe(true);
    expect(JSON.parse(read(".release-please-manifest.json"))).toEqual({
      ".": "0.0.0",
    });
  });
  it("first release is 0.1.0 via initial-version", () => {
    const c = JSON.parse(read("release-please-config.json"));
    expect(c.packages["."]["initial-version"]).toBe("0.1.0");
  });
});

describe(".nvmrc", () => {
  it("pins Node >= 22 because wrangler 4 requires it", () => {
    const major = Number.parseInt(read(".nvmrc").trim().replace(/^v/, ""), 10);
    expect(major).toBeGreaterThanOrEqual(22);
  });
});

describe("package.json engines", () => {
  it("requires Node >=22 in every tracked package.json", () => {
    const files = execFileSync("git", ["ls-files", "*package.json"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect([f, JSON.parse(read(f)).engines?.node]).toEqual([f, ">=22"]);
    }
  });
});
