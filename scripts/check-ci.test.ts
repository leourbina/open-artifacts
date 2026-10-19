import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/*
 * Invariants instead of pinned values (what changed and why):
 * - ci.yml triggers/jobs: exact lists -> "contains at least" (extra triggers
 *   or jobs, e.g. an audit job, must not break the suite). The five required
 *   check names stay mandatory.
 * - deploy-staging.yml: exact job list / trigger list -> contains; smoke
 *   `needs` must include deploy. Curl `--retry N --retry-delay N
 *   --retry-max-time N` numbers are tuning knobs -> matched by shape.
 * - landing-preview.yml: exact paths/types lists -> contains.
 * - release-please.yml: exact trigger list / permissions -> contains / at
 *   least write on these scopes; action pinned `@v4` -> any `@vN`.
 * - release-please-config: Manifest version: semver validity + equal to or ahead of the
 *   latest local v* git tag (skipped when no tags exist).
 * - package.json engines: exact ">=22" -> any ">=N" with N >= 22.
 * - ops-staging-access inputs: exact -> contains.
 * Kept as contracts: required check names, release-type node,
 * include-component-in-tag false, initial-version 0.1.0,
 * bump-minor-pre-major true (false would release 1.0.0), dispatch-only ops
 * workflow, shared "staging" concurrency, secret names/scoping, no tracing,
 * redirect/robots/CSP-style smoke assertions.
 */
const semver = (v: string) =>
  v.split(".").map(Number) as [number, number, number];
const cmp = (a: string, b: string) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++)
    if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return 0;
};
const latestTag = (): string | undefined => {
  const tags = execFileSync("git", ["tag", "--list", "v*"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .map((t) => t.slice(1))
    .sort(cmp);
  return tags.at(-1);
};
const ci = (n: string) => read(`scripts/ci/${n}`);
const RETRY_FLAGS = /--retry \d+ --retry-delay \d+ --retry-max-time \d+/;

describe("ci.yml", () => {
  const w = wf("ci.yml");
  it("triggers on pull_request and push to main", () => {
    expect(triggers(w)).toEqual(
      expect.arrayContaining(["pull_request", "push", "workflow_dispatch"]),
    );
    expect(w.on.push.branches).toContain("main");
    expect("workflow_dispatch" in w.on).toBe(true);
  });
  it("defines at least the five required jobs", () => {
    expect(Object.keys(w.jobs)).toEqual(
      expect.arrayContaining(["build", "e2e", "lint", "test", "typecheck"]),
    );
  });
  it("lint job runs actionlint at a pinned version with checksum", () => {
    // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
    const step = w.jobs.lint.steps.find((s: any) =>
      (s.run ?? "").includes("actionlint"),
    );
    expect(step).toBeDefined();
    expect(step.env.ACTIONLINT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(step.env.ACTIONLINT_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(step.run).not.toMatch(/latest/);
    expect(step.run).toContain("sha256sum -c");
    expect(step.run).toContain("command -v shellcheck");
    expect(step.run).toContain(".github/workflows/*.yml");
  });
  it("e2e job runs both Playwright suites locally, with cached browsers", () => {
    const job = w.jobs.e2e;
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(20);
    // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
    const steps: any[] = job.steps;
    const runs = steps.map((s) => s.run ?? "");
    const at = (needle: string) => runs.findIndex((r) => r.includes(needle));
    const order = [
      "pnpm install --frozen-lockfile",
      "e2e.sh version",
      "e2e.sh install",
      "e2e.sh hosts",
      "e2e.sh mock",
      "e2e.sh real",
    ].map(at);
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // A mock failure must not skip the real suite; a failed browser install must.
    expect(steps[order[2] as number].id).toBe("install");
    expect(steps[order[5] as number].if).toMatch(
      /^\$\{\{ !cancelled\(\) && steps\.install\.outcome == 'success' \}\}$/,
    );
    const cache = steps.find((s) =>
      (s.uses ?? "").startsWith("actions/cache@"),
    );
    expect(cache.with.path).toBe("~/.cache/ms-playwright");
    expect(cache.with.key).toContain("steps.pw.outputs.playwright");
    const upload = steps.find((s) =>
      (s.uses ?? "").startsWith("actions/upload-artifact@"),
    );
    expect(upload.if).toBe("failure()");
    expect(upload.with.path).toContain("apps/dashboard/playwright-report");
    // Local wrangler dev only: no secrets, nothing pointing at staging.
    const s = JSON.stringify(job);
    expect(s).not.toContain("secrets.");
    expect(s).not.toContain("staging");
    expect(ci("e2e.sh")).toContain(
      "playwright install --with-deps chromium webkit",
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
    expect(triggers(w)).toContain("push");
    expect(w.on.push.branches).toContain("main");
    expect(w.concurrency).toEqual({
      group: "staging",
      "cancel-in-progress": false,
    });
  });
  it("has deploy then smoke jobs", () => {
    expect(Object.keys(w.jobs)).toEqual(
      expect.arrayContaining(["deploy", "smoke"]),
    );
    expect([w.jobs.smoke.needs].flat()).toContain("deploy");
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
    const p = idx("deploy", "staging-preflight.sh");
    expect(p).toBeGreaterThan(idx("deploy", "pnpm build"));
    expect(p).toBeLessThan(idx("deploy", "d1 migrations apply"));
    expect(p).toBeLessThan(idx("deploy", "wrangler deploy"));
    expect(runs("deploy")[p]).toContain("scripts/ci/staging-preflight.sh");
    const step = ci("staging-preflight.sh");
    expect(step).toContain("check-staging-secrets");
    expect(step).toContain("wrangler secret list");
    expect(step).toContain("--format json");
    expect(step).toContain("set -euo pipefail");
    expect(step).toContain("wrangler.staging.jsonc");
    expect(step).toContain("--env staging");
  });
  it("clears conflicting secrets after preflight and before deploy", () => {
    const p = idx("deploy", "staging-preflight.sh");
    const c = idx("deploy", "staging-clear-conflicts.sh");
    expect(c).toBeGreaterThan(p);
    expect(c).toBeLessThan(idx("deploy", "wrangler deploy"));
    const step = ci("staging-clear-conflicts.sh");
    expect(step).toContain("conflicting-secrets");
    expect(step).toContain("set -euo pipefail");
    expect(step).toContain("wrangler secret list");
    expect(step).toContain(
      'wrangler secret delete "$name" -c wrangler.staging.jsonc --env staging',
    );
    expect(step).toContain("echo y |");
  });
  it("ensures dashboard dist exists before wrangler deploy", () => {
    const e = idx("deploy", "ensure-dashboard-dist.sh");
    expect(e).toBeGreaterThan(idx("deploy", "pnpm build"));
    expect(e).toBeLessThan(idx("deploy", "wrangler deploy"));
    expect(ci("ensure-dashboard-dist.sh")).toContain("index.html");
  });
  it("smoke asserts /auth/login redirects to Cloudflare Access", () => {
    const all = runs("smoke").join("\n") + ci("staging-smoke.sh");
    expect(all).toContain(
      "staging-smoke.sh login https://staging.open-artifacts.com",
    );
    expect(all).toContain("/auth/login");
    expect(all).toMatch(RETRY_FLAGS);
    expect(all).not.toMatch(/\s-[a-zA-Z]*L\b|--location/);
    expect(all).toContain("302");
    expect(all).toContain(
      `sed -n 's/.*"ACCESS_TEAM_DOMAIN": *"\\([^"]*\\)".*/\\1/p' "$config" | head -1`,
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
    expect(all).toContain("robots https://staging-content.open-artifacts.com");
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
    const all = runs("smoke").join("\n") + ci("staging-smoke.sh");
    expect(all).toContain("healthz https://staging.open-artifacts.com");
    expect(all).toMatch(RETRY_FLAGS);
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
    expect(w.on.pull_request.paths).toContain("apps/landing/**");
    expect(w.on.pull_request.types).toEqual(
      expect.arrayContaining(["opened", "synchronize", "reopened", "closed"]),
    );
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
    const script = ci("landing-preview-url.sh");
    expect(script).toContain('wrangler preview --name "pr-$pr"');
    expect(script).toContain("--json");
    expect(raw).not.toContain("versions upload");
    expect(script).not.toContain("versions upload");
  });
  it("gates early and fails without a URL", () => {
    expect(steps.some((s) => s.id === "gate")).toBe(true);
    const install = steps.find((s) => (s.run ?? "").includes("pnpm install"));
    expect(install.if).toContain("steps.gate.outputs.present");
    const prev = steps.find((s) => s.id === "preview");
    expect(prev.run).toContain("scripts/ci/landing-preview-url.sh");
    expect(ci("landing-preview-url.sh")).toContain("jq -er");
    expect(prev.run).not.toContain("|| true");
    expect(ci("landing-preview-url.sh")).not.toContain("|| true");
  });
  it("hides the wrangler banner and extracts JSON from stdout", () => {
    const prev = steps.find((s) => s.id === "preview");
    expect(prev.env.WRANGLER_HIDE_BANNER).toBe("true");
    const script = ci("landing-preview-url.sh");
    expect(script).toContain("sed -n '/^{/,$p'");
    expect(script).toContain("cat preview.json");
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
    expect(triggers(w)).toEqual(
      expect.arrayContaining(["push", "workflow_dispatch"]),
    );
    expect(w.on.push.branches).toContain("main");
    expect(w.permissions).toMatchObject({
      actions: "write",
      contents: "write",
      "pull-requests": "write",
    });
    expect(read(".github/workflows/release-please.yml")).toMatch(
      /googleapis\/release-please-action@v\d+/,
    );
  });
  it("dispatches CI on the release branch and deploys the tag", () => {
    const raw = read(".github/workflows/release-please.yml");
    expect(raw).toContain("scripts/ci/release-pr-dispatch.sh");
    expect(ci("release-pr-dispatch.sh")).toContain("gh workflow run ci.yml");
    expect(ci("release-pr-dispatch.sh")).toContain("headRefName");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(raw).toContain("needs.release-please.outputs.tag_name");
    const gate = wf("release-please.yml").jobs["deploy-landing"].steps;
    expect(JSON.stringify(gate)).toContain("steps.gate.outputs.present");
  });
  it("dispatches CI whenever the release PR exists, not only when created", () => {
    const steps = wf("release-please.yml").jobs["release-please"].steps;
    // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
    const step = steps.find((s: any) =>
      (s.run ?? "").includes("release-pr-dispatch.sh"),
    );
    expect(step).toBeDefined();
    expect(String(step.if ?? "")).not.toBe(
      "steps.rp.outputs.prs_created == 'true'",
    );
    expect(String(step.if ?? "")).toContain("release_created");
    expect(ci("release-pr-dispatch.sh")).toContain("gh pr list");
    expect(step.env.BRANCH).toContain("release-please--branches--main");
  });
  it("deploy-landing uses no scripts/ci files (older tags lack them)", () => {
    const steps = wf("release-please.yml").jobs["deploy-landing"].steps;
    expect(JSON.stringify(steps)).not.toContain("scripts/ci");
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
  it("config is release-type node, manifest has a single semver at '.'", () => {
    const c = JSON.parse(read("release-please-config.json"));
    expect(c.packages["."]["release-type"]).toBe("node");
    // Must stay true: main has BREAKING CHANGES; false would release 1.0.0.
    expect(c.packages["."]["bump-minor-pre-major"]).toBe(true);
    const m = JSON.parse(read(".release-please-manifest.json"));
    expect(Object.keys(m)).toEqual(["."]);
    expect(m["."]).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it("manifest version is the latest v* tag or ahead of it", () => {
    const tag = latestTag();
    if (!tag) return; // no tags locally (e.g. shallow clone): nothing to compare
    const m = JSON.parse(read(".release-please-manifest.json"));
    expect(cmp(m["."], tag)).toBeGreaterThanOrEqual(0);
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
      const node: string | undefined = JSON.parse(read(f)).engines?.node;
      const major = Number(/^>=\s*(\d+)/.exec(node ?? "")?.[1]);
      expect([f, major >= 22]).toEqual([f, true]);
    }
  });
});

describe("ops-staging-access.yml", () => {
  const w = wf("ops-staging-access.yml");
  const raw = read(".github/workflows/ops-staging-access.yml");
  it("is workflow_dispatch only", () => {
    expect(triggers(w)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(w.on.workflow_dispatch.inputs)).toEqual(
      expect.arrayContaining(["force_rotate", "team_name"]),
    );
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

describe("prod and staging tokens never cross", () => {
  const dir = join(root, ".github/workflows");
  const refs = (file: string, base = dir): Set<string> => {
    const out = new Set<string>();
    const walk = (v: unknown) => {
      if (typeof v === "string")
        for (const m of v.matchAll(/secrets\.([A-Za-z0-9_]+)/g))
          out.add(m[1] as string);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(parse(readFileSync(join(base, file), "utf8")));
    return out;
  };
  // Returns violations for every workflow file in `base`.
  const violations = (base: string) => {
    const bad: string[] = [];
    for (const f of readdirSync(base).filter((n) => /\.ya?ml$/.test(n))) {
      const r = refs(f, base);
      const isProd = f.includes("prod");
      if (!isProd && r.has("PROD_CLOUDFLARE_API_TOKEN")) {
        // Exception: a job named deploy-prod, in a file whose other jobs never touch the PROD secret.
        const jobs = (parse(readFileSync(join(base, f), "utf8")).jobs ??
          {}) as Record<string, unknown>;
        for (const [name, job] of Object.entries(jobs)) {
          const s = JSON.stringify(job);
          if (s.includes("secrets.PROD_CLOUDFLARE_API_TOKEN")) {
            if (name !== "deploy-prod")
              bad.push(`${f}: job ${name} uses PROD_CLOUDFLARE_API_TOKEN`);
            else if (/secrets\.CLOUDFLARE_API_TOKEN/.test(s))
              bad.push(`${f}: job ${name} mixes PROD and staging tokens`);
          }
        }
      }
      if (isProd && r.has("CLOUDFLARE_API_TOKEN"))
        bad.push(`${f}: prod workflow uses CLOUDFLARE_API_TOKEN`);
    }
    return bad;
  };
  it("real workflows have no crossings", () => {
    expect(violations(dir)).toEqual([]);
  });
  it("staging workflows never reference the PROD secret", () => {
    for (const f of [
      "deploy-staging.yml",
      "ops-staging-access.yml",
      "landing-preview.yml",
    ])
      expect(refs(f), f).not.toContain("PROD_CLOUDFLARE_API_TOKEN");
  });
  it("the prod check workflow uses the PROD secret", () => {
    expect(refs("ops-prod-token-check.yml")).toContain(
      "PROD_CLOUDFLARE_API_TOKEN",
    );
  });
  describe("ops-prod-install.yml", () => {
    const f = "ops-prod-install.yml";
    const w = wf(f);
    const text = readFileSync(join(dir, f), "utf8");
    const steps = w.jobs.install.steps as {
      name?: string;
      env?: Record<string, string>;
      run?: string;
    }[];
    it("is dispatch-only and main-only", () => {
      expect(Object.keys(w.on)).toEqual(["workflow_dispatch"]);
      expect(w.jobs.install.if).toBe("github.ref == 'refs/heads/main'");
    });
    it("has a stable-tag guard step", () => {
      const g = steps.find((s) => /stable/i.test(s.name ?? ""));
      expect(g?.run).toContain("releases/latest");
    });
    it("has an always() revoke step using only the PROD token", () => {
      const r = steps.find((s) => s.run?.includes("--revoke-ci-tokens")) as any;
      expect(r).toBeDefined();
      expect(r.if).toBe("always()");
      expect(r["continue-on-error"]).toBe(false);
      expect(r["timeout-minutes"]).toBe(3);
      expect(r.env.CLOUDFLARE_API_TOKEN).toBe(
        "${{ secrets.PROD_CLOUDFLARE_API_TOKEN }}",
      );
      expect(JSON.stringify(r.env)).not.toMatch(
        /secrets\.CLOUDFLARE_API_TOKEN/,
      );
    });
    it("scopes tokens to the setup step and uses --ci", () => {
      const withTok = steps.filter((s) =>
        JSON.stringify(s.env ?? {}).includes("secrets."),
      );
      expect(withTok).toHaveLength(2);
      expect(withTok[0]?.env).toHaveProperty("OA_ACCESS_TOKEN");
      expect(w.env ?? {}).not.toHaveProperty("OA_ACCESS_TOKEN");
      expect(text).not.toMatch(/secrets\.CLOUDFLARE_API_TOKEN/);
      expect(text).toContain("--ci");
      expect([...refs(f)].sort()).toEqual([
        "CLOUDFLARE_ACCOUNT_ID",
        "PROD_CLOUDFLARE_API_TOKEN",
      ]);
    });
  });
  describe("release-please.yml deploy-prod", () => {
    const f = "release-please.yml";
    const w = wf(f);
    const job = w.jobs["deploy-prod"];
    const steps = job.steps as {
      id?: string;
      if?: string;
      env?: Record<string, string>;
      run?: string;
    }[];
    const tok = "${{ secrets.PROD_CLOUDFLARE_API_TOKEN }}";
    it("only the deploy-prod job references the PROD secret", () => {
      for (const [n, j] of Object.entries(w.jobs))
        expect(JSON.stringify(j).includes("PROD_CLOUDFLARE_API_TOKEN"), n).toBe(
          n === "deploy-prod",
        );
      expect(job.env ?? {}).not.toHaveProperty("OA_ACCESS_TOKEN");
      expect(JSON.stringify(job.env ?? {})).not.toContain("secrets.");
    });
    it("runs only on a release event or main-ref dispatch, never a bare push", () => {
      expect(job.if).toContain("release_created == 'true'");
      expect(job.if).toContain("github.event_name == 'workflow_dispatch'");
      expect(job.if).toContain("github.ref == 'refs/heads/main'");
      expect(job.needs).toEqual(["release-please"]);
      expect(job.if).not.toMatch(/event_name == 'push'/);
      expect(job.concurrency).toEqual({
        group: "prod",
        "cancel-in-progress": false,
      });
    });
    it("guards stable-only (prerelease and latest)", () => {
      const g = steps.find((s) => s.id === "guard");
      expect(g?.run).toContain("isPrerelease");
      expect(g?.run).toContain("releases/latest");
      expect(g?.env).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    });
    it("preflight, then --ci upgrade, then always() cleanup; step-scoped token", () => {
      const at = (m: string) => steps.findIndex((s) => s.run?.includes(m));
      const [pre, up, cl] = [
        at("prod-setup.sh preflight"),
        at("prod-setup.sh upgrade"),
        at("prod-setup.sh cleanup"),
      ];
      expect(pre).toBeGreaterThan(0);
      expect(up).toBeGreaterThan(pre);
      expect(cl).toBeGreaterThan(up);
      expect(steps[cl]?.if).toContain("always()");
      expect(steps[pre]?.if ?? "").not.toContain("always()");
      expect(steps[up]?.if ?? "").not.toContain("always()");
      const withTok = steps.filter((s) =>
        JSON.stringify(s.env ?? {}).includes("secrets."),
      );
      expect(withTok).toHaveLength(3);
      for (const s of withTok) {
        expect(s.env?.CLOUDFLARE_API_TOKEN).toBe(tok);
        expect(s.env?.OA_ACCESS_TOKEN).toBe(tok);
      }
      const sh = readFileSync(join(root, "scripts/ci/prod-setup.sh"), "utf8");
      expect(sh).toContain(
        "upgrade) mode_args=(--ci --upgrade --solo --browser)",
      );
      expect(sh).toContain("install) mode_args=(--ci --solo --browser)");
      expect(sh).toContain("--check --strict --upgrade --solo --browser");
      expect(sh).toContain("--ci --revoke-ci-tokens");
    });
    it("deploy-landing stays independent of deploy-prod", () => {
      expect(w.jobs["deploy-landing"].needs).toEqual(["release-please"]);
      expect(JSON.stringify(w.jobs["deploy-landing"])).not.toContain(
        "deploy-prod",
      );
    });
  });
  it("detects a crossing fixture", () => {
    const tmp = mkdtempSync(join(tmpdir(), "wf-"));
    writeFileSync(
      join(tmp, "deploy-prod.yml"),
      "on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: x\n        env:\n          A: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n",
    );
    writeFileSync(
      join(tmp, "stage.yml"),
      "on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: x\n        env:\n          A: ${{ secrets.PROD_CLOUDFLARE_API_TOKEN }}\n",
    );
    expect(violations(tmp)).toHaveLength(2);
  });
});

describe("workflow jobs that use repo files have a checkout", () => {
  const usesRepo = (s: { run?: string; "working-directory"?: string }) =>
    /(^|[\s"'=])(\.\/|(\.\.\/)+)?scripts\//.test(s.run ?? "") ||
    /(^|[\s"'=])(\.\.\/)+scripts\//.test(s.run ?? "") ||
    (!!s["working-directory"] &&
      !/^(\/|~|\$|\$\{\{)/.test(s["working-directory"]));
  const dir = join(root, ".github/workflows");
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    for (const [job, def] of Object.entries(
      // biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
      (wf(file).jobs ?? {}) as Record<string, any>,
    )) {
      it(`${file} job ${job}`, () => {
        let checkedOut = false;
        const bad: string[] = [];
        for (const s of def.steps ?? []) {
          if (String(s.uses ?? "").startsWith("actions/checkout")) {
            checkedOut = true;
          } else if (usesRepo(s) && !checkedOut) {
            bad.push(s.run ?? s["working-directory"]);
          }
        }
        expect(
          bad,
          `${file} job ${job} uses repo files before actions/checkout`,
        ).toEqual([]);
      });
    }
  }
});
