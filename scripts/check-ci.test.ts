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
  it("preflights required Worker secrets before migrate and deploy", () => {
    const p = idx("deploy", "check-staging-secrets");
    expect(p).toBeGreaterThan(idx("deploy", "pnpm build"));
    expect(p).toBeLessThan(idx("deploy", "d1 migrations apply"));
    expect(p).toBeLessThan(idx("deploy", "wrangler deploy"));
    const step = runs("deploy")[p] as string;
    expect(step).toContain("wrangler secret list");
    expect(step).toContain("--format json");
    expect(step).toContain("set -o pipefail");
    expect(step).toContain("wrangler.staging.jsonc");
    expect(step).toContain("--env staging");
  });
  it("clears conflicting secrets after preflight and before deploy", () => {
    const p = idx("deploy", "check-staging-secrets");
    const c = idx("deploy", "conflicting-secrets");
    expect(c).toBeGreaterThan(p);
    expect(c).toBeLessThan(idx("deploy", "wrangler deploy"));
    const step = runs("deploy")[c] as string;
    expect(step).toContain("set -o pipefail");
    expect(step).toContain("wrangler secret list");
    expect(step).toContain(
      'wrangler secret delete "$name" -c wrangler.staging.jsonc --env staging',
    );
    expect(step).toContain("echo y |");
  });
  it("ensures dashboard dist exists before wrangler deploy", () => {
    const e = idx("deploy", "mkdir -p apps/dashboard/dist");
    expect(e).toBeGreaterThan(idx("deploy", "pnpm build"));
    expect(e).toBeLessThan(idx("deploy", "wrangler deploy"));
    expect(runs("deploy")[e]).toContain("apps/dashboard/dist/index.html");
  });
  it("smoke asserts /auth/login redirects to Cloudflare Access", () => {
    const all = runs("smoke").join("\n");
    expect(all).toContain("staging.open-artifacts.com/auth/login");
    expect(all).toContain("--retry 20 --retry-delay 5 --retry-max-time 180");
    expect(all).not.toMatch(/\s-[a-zA-Z]*L\b|--location/);
    expect(all).toContain("302");
    expect(all).toContain(
      `sed -n 's/.*"ACCESS_TEAM_DOMAIN": *"\\([^"]*\\)".*/\\1/p' apps/server/wrangler.staging.jsonc | head -1`,
    );
    expect(all).toContain("tr -d '\\r'");
    expect(all).toContain("grep -i '^location:'");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell
    expect(all).toContain('[ "${loc#"$prefix"}" != "$loc" ]');
    expect(all).toContain('prefix="https://$team/cdn-cgi/access/sso/oidc/"');
    expect(all).toContain("END{print b}");
    expect(all).toMatch(/[Ll]ocation/);
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
  const sameRepo =
    "github.event.pull_request.head.repo.full_name == github.repository";
  // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
  const steps = w.jobs.preview.steps as any[];
  it("triggers on PRs touching apps/landing, incl. closed", () => {
    expect(triggers(w)).toEqual(["pull_request"]);
    expect(w.on.pull_request.paths).toEqual(["apps/landing/**"]);
    expect(w.on.pull_request.types).toEqual([
      "opened",
      "synchronize",
      "reopened",
      "closed",
    ]);
  });
  it("skips fork PRs and closed events in the preview job", () => {
    expect(w.jobs.preview.if).toContain(sameRepo);
    expect(w.jobs.preview.if).toContain("github.event.action != 'closed'");
  });
  it("serializes per PR", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(w.concurrency.group).toBe(
      "landing-preview-${{ github.event.pull_request.number }}",
    );
  });
  it("uses wrangler preview, never versions upload", () => {
    expect(raw).toContain("wrangler preview --name pr-");
    expect(raw).toContain("--json");
    expect(raw).not.toContain("versions upload");
  });
  it("gates early and fails without a URL", () => {
    expect(steps.some((s) => s.id === "gate")).toBe(true);
    const install = steps.find((s) => (s.run ?? "").includes("pnpm install"));
    expect(install.if).toContain("steps.gate.outputs.present");
    const prev = steps.find((s) => s.id === "preview");
    expect(prev.run).toContain("jq -er");
    expect(prev.run).not.toContain("|| true");
  });
  it("hides the wrangler banner and extracts JSON from stdout", () => {
    const prev = steps.find((s) => s.id === "preview");
    expect(prev.env.WRANGLER_HIDE_BANNER).toBe("true");
    expect(prev.run).toContain("sed -n '/^{/,$p'");
    expect(prev.run).toContain("cat preview.json");
  });
  it("scopes the Cloudflare token to the preview step only", () => {
    expect(w.jobs.preview.env).toBeUndefined();
    expect(w.env).toBeUndefined();
    const prev = steps.find((s) => s.id === "preview");
    expect(prev.env.CLOUDFLARE_API_TOKEN).toContain(
      "secrets.CLOUDFLARE_API_TOKEN",
    );
    const others = steps.filter((s) => s.id !== "preview");
    expect(JSON.stringify(others)).not.toContain("CLOUDFLARE_API_TOKEN");
  });
  it("updates one sticky comment via marker", () => {
    const gh = steps.find((s) => s.uses?.startsWith("actions/github-script"));
    expect(gh.env.PREVIEW_URL).toBeDefined();
    expect(gh.with.script).toContain("<!-- landing-preview -->");
    expect(gh.with.script).toContain("updateComment");
    expect(gh.with.script).toContain("createComment");
    expect(gh.with.script).not.toContain("${{");
  });
  it("deletes the preview when the PR closes", () => {
    const c = w.jobs.cleanup;
    expect(c.if).toContain(sameRepo);
    expect(c.if).toContain("github.event.action == 'closed'");
    expect(raw).toContain("wrangler preview delete --name pr-");
    expect(raw).toContain("--skip-confirmation");
    expect(JSON.stringify(c.steps)).toContain("steps.gate.outputs.present");
  });
});

describe("release-please", () => {
  it("workflow triggers on push to main with write permissions", () => {
    const w = wf("release-please.yml");
    expect(triggers(w).sort()).toEqual(["push", "workflow_dispatch"]);
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
    expect(raw).toContain("needs.release-please.outputs.tag_name");
    const gate = wf("release-please.yml").jobs["deploy-landing"].steps;
    expect(JSON.stringify(gate)).toContain("steps.gate.outputs.present");
  });
  it("gates landing deploy on a release-ready dist, between build and deploy", () => {
    const steps = wf("release-please.yml").jobs["deploy-landing"].steps;
    // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
    const runs: string[] = steps.map((s: any) => s.run ?? "");
    const at = (n: string) => runs.findIndex((r) => r.includes(n));
    const b = at("pnpm --filter @oa/landing build");
    const g = at("scripts/ops/check-landing-dist.ts");
    const d = at("wrangler deploy");
    expect(b).toBeGreaterThanOrEqual(0);
    expect(g).toBeGreaterThan(b);
    expect(d).toBeGreaterThan(g);
    expect(runs[b]).not.toContain("wrangler deploy");
    expect(read(".github/workflows/release-please.yml")).toContain(
      "failing here does not undo the release",
    );
  });
  it("workflow_dispatch takes a tag and runs only deploy-landing", () => {
    const w = wf("release-please.yml");
    expect(w.on.workflow_dispatch.inputs.tag.required).toBe(true);
    expect(w.jobs["release-please"].if).toContain("push");
    const d = w.jobs["deploy-landing"];
    expect(d.if).toContain("workflow_dispatch");
    expect(JSON.stringify(d.steps)).toContain("inputs.tag");
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
  it("release tags are vX.Y.Z without the component prefix", () => {
    const c = JSON.parse(read("release-please-config.json"));
    expect(c.packages["."]["include-component-in-tag"]).toBe(false);
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

describe("ops-staging-access.yml", () => {
  const w = wf("ops-staging-access.yml");
  const raw = read(".github/workflows/ops-staging-access.yml");
  it("is workflow_dispatch only", () => {
    expect(triggers(w)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(w.on.workflow_dispatch.inputs).sort()).toEqual([
      "force_rotate",
      "team_name",
    ]);
  });
  it("never enables shell tracing", () => {
    expect(raw).not.toMatch(/set\s+-[a-wyz]*x/);
    expect(raw).not.toMatch(/set\s+-o\s+xtrace/);
  });
  it("runs the tested script with Cloudflare secrets", () => {
    expect(raw).toContain("scripts/ops/staging-access.ts");
    expect(raw).toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(raw).toContain("secrets.CLOUDFLARE_ACCOUNT_ID");
  });
});

describe("ops-staging-access.yml hardening", () => {
  const w = wf("ops-staging-access.yml");
  it("keeps the Cloudflare token out of job-level env", () => {
    expect(w.jobs.access.env?.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(w.jobs.access.env?.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
    // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
    const prov = w.jobs.access.steps.find((s: any) =>
      (s.run ?? "").includes("scripts/ops/staging-access.ts"),
    );
    expect(Object.keys(prov.env)).toEqual(
      expect.arrayContaining(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]),
    );
  });
  it("shares the staging concurrency group with deploy-staging", () => {
    const want = { group: "staging", "cancel-in-progress": false };
    expect(w.concurrency).toEqual(want);
    expect(wf("deploy-staging.yml").concurrency).toEqual(want);
  });
  it("only runs on main", () => {
    expect(w.jobs.access.if).toBe("github.ref == 'refs/heads/main'");
  });
});
