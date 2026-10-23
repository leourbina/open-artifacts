// T3b: the hosted release jobs in release-please.yml (guard, build, check,
// sign, attach). The signing key never shares a job with installed code.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const w: any = parse(read(".github/workflows/release-please.yml"));
const HOSTED = [
  "hosted-guard",
  "hosted-build",
  "hosted-check",
  "hosted-sign",
  "hosted-attach",
];
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
type Step = Record<string, any>;
const steps = (job: string): Step[] => w.jobs[job].steps;
const needs = (job: string): string[] => [w.jobs[job].needs ?? []].flat();
const SHA_PIN =
  /^(actions\/(checkout|download-artifact|upload-artifact|setup-node)|pnpm\/action-setup)@[0-9a-f]{40}$/;
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
const GUARD_SHA = "${{ needs.hosted-guard.outputs.sha }}";

describe("release-please.yml hosted jobs", () => {
  it("has the five hosted jobs", () => {
    expect(Object.keys(w.jobs)).toEqual(expect.arrayContaining(HOSTED));
  });

  describe("hosted-guard", () => {
    const job = w.jobs["hosted-guard"];
    const run = steps("hosted-guard")
      .map((s) => s.run ?? "")
      .join("\n");
    it("runs only on a release-please release from a push to main, or a dispatch on main", () => {
      expect(job.if).toContain("github.ref == 'refs/heads/main'");
      expect(job.if).toContain(
        "github.event_name == 'push' && needs.release-please.outputs.release_created == 'true'",
      );
      expect(job.if).toContain("github.event_name == 'workflow_dispatch'");
      expect(needs("hosted-guard")).toEqual(["release-please"]);
    });
    it("has no secrets, no checkout and read-only permissions", () => {
      expect(JSON.stringify(job)).not.toContain("secrets.");
      expect(JSON.stringify(job)).not.toContain("actions/checkout");
      expect(job.permissions).toEqual({ contents: "read" });
    });
    it("resolves the tag to a commit once, requires it behind or identical to main and the package.json version", () => {
      expect(run.match(/git\/ref\/tags\//g)).toHaveLength(1);
      expect(run).toContain("compare/main...$sha");
      expect(run).toMatch(/behind\|identical|identical\|behind/);
      expect(run).toContain("contents/package.json?ref=$sha");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell expansion
      expect(run).toContain('"${TAG#v}"');
      expect(run).toContain("isPrerelease");
      // The tag reaches the script as an env var, never as an expression.
      expect(run).not.toContain("${{");
      expect(job.outputs.sha).toMatch(/steps\.\w+\.outputs\.sha/);
    });
  });

  for (const name of HOSTED.slice(1))
    it(`${name} needs hosted-guard and checks out exactly its SHA`, () => {
      expect(needs(name)).toContain("hosted-guard");
      const co = steps(name).filter((s) =>
        String(s.uses ?? "").startsWith("actions/checkout"),
      );
      expect(co.length).toBeGreaterThan(0);
      for (const c of co) {
        expect(c.with?.ref).toBe(GUARD_SHA);
        expect(c.with?.["persist-credentials"]).toBe(false);
      }
    });

  it("every hosted job pins its actions by SHA", () => {
    for (const name of HOSTED)
      for (const s of steps(name))
        if (s.uses) expect(s.uses, name).toMatch(SHA_PIN);
  });

  it("hosted-build has no secrets, contents: read, builds both variants and uploads one artifact", () => {
    const job = w.jobs["hosted-build"];
    expect(JSON.stringify(job)).not.toContain("secrets.");
    expect(job.permissions).toEqual({ contents: "read" });
    const run = steps("hosted-build")
      .map((s) => s.run ?? "")
      .join("\n");
    expect(run).toContain("scripts/ci/build-hosted-release.ts");
    // Each variant's manifest entry records the guard's commit.
    expect(run).toMatch(
      /build-hosted-release\.ts "\$RUNNER_TEMP\/hosted" --commit "\$GUARD_SHA"/,
    );
    const st = steps("hosted-build").find((x) =>
      (x.run ?? "").includes("build-hosted-release"),
    );
    expect(st?.env?.GUARD_SHA).toBe(GUARD_SHA);
    const up = steps("hosted-build").filter((s) =>
      String(s.uses ?? "").startsWith("actions/upload-artifact"),
    );
    expect(up).toHaveLength(1);
    expect(up[0]?.with?.name).toBe("hosted-release");
  });

  it("hosted-check has no secrets, verifies the manifest, runs check-no-test-hooks on the artifact and outputs the hashes", () => {
    const job = w.jobs["hosted-check"];
    expect(JSON.stringify(job)).not.toContain("secrets.");
    expect(job.permissions).toEqual({ contents: "read" });
    expect(needs("hosted-check")).toContain("hosted-build");
    const run = steps("hosted-check")
      .map((s) => s.run ?? "")
      .join("\n");
    expect(run).toContain("scripts/ci/check-hosted-release.ts");
    expect(run).toMatch(
      /pnpm check-no-test-hooks "\$RUNNER_TEMP\/hosted\/release"/,
    );
    expect(Object.keys(job.outputs).sort()).toEqual([
      "bundle_sha256",
      "manifest_sha256",
    ]);
  });

  describe("hosted-sign", () => {
    const job = w.jobs["hosted-sign"];
    const st = steps("hosted-sign");
    it("is a matrix over env with environment hosted-<env>, needing build and check", () => {
      expect(job.strategy.matrix.env).toEqual(["staging", "prod"]);
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      expect(job.environment).toBe("hosted-${{ matrix.env }}");
      expect(needs("hosted-sign")).toEqual(
        expect.arrayContaining([
          "hosted-guard",
          "hosted-build",
          "hosted-check",
        ]),
      );
      expect(job.permissions).toEqual({ contents: "read" });
    });
    it("has exactly three steps: checkout (no credentials), download-artifact, node sign-release.ts", () => {
      expect(st).toHaveLength(3);
      expect(st[0]?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
      expect(st[0]?.with?.["persist-credentials"]).toBe(false);
      expect(st[1]?.uses).toMatch(/^actions\/download-artifact@[0-9a-f]{40}$/);
      expect(st[2]?.uses).toBeUndefined();
      expect(st[2]?.run).toContain(
        "node --experimental-strip-types scripts/ci/sign-release.ts",
      );
    });
    it("uses only checkout and download-artifact", () => {
      const uses = st.map((s) => s.uses).filter(Boolean);
      for (const u of uses)
        expect(u).toMatch(
          /^actions\/(checkout|download-artifact)@[0-9a-f]{40}$/,
        );
    });
    it("installs nothing: no pnpm, npm, npx or corepack", () => {
      // Any invocation (the lockfile path "pnpm-lock.yaml" is not one).
      const cmd = /(^|[\s;|&(`])(pnpm|npm|npx|corepack|yarn)(?=$|[\s;|&)`])/m;
      for (const s of st) expect(s.run ?? "").not.toMatch(cmd);
      expect(cmd.test("x && pnpm install")).toBe(true);
      expect(cmd.test("npx foo")).toBe(true);
      expect(cmd.test("--lockfile pnpm-lock.yaml")).toBe(false);
    });
    it("has no Cloudflare secret", () => {
      expect(JSON.stringify(job)).not.toMatch(/CLOUDFLARE_/);
    });
    it("reads the key only through the printf pipe on stdin", () => {
      const withKey = st.filter((s) =>
        JSON.stringify(s).includes("RELEASE_SIGNING_KEY"),
      );
      expect(withKey).toEqual([st[2]]);
      expect(st[2]?.env?.RELEASE_SIGNING_KEY).toBe(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
        "${{ secrets.RELEASE_SIGNING_KEY }}",
      );
      const run = String(st[2]?.run);
      expect(run).toMatch(
        /printf '%s' "\$RELEASE_SIGNING_KEY" \| node --experimental-strip-types scripts\/ci\/sign-release\.ts /,
      );
      expect(run.match(/RELEASE_SIGNING_KEY/g)).toHaveLength(1);
      expect(run).not.toMatch(/set -x|set -o xtrace|--key/);
      expect(JSON.stringify(job.env ?? {})).not.toContain(
        "RELEASE_SIGNING_KEY",
      );
      expect(Object.keys(job).filter((k) => k === "env")).toEqual([]);
      // The only secret in the run is the signing key, in this step.
      expect(JSON.stringify(st.slice(0, 2))).not.toContain("secrets.");
    });
    it("passes hosted-check's hashes, the guard's commit and the checked-out lockfile to the signer", () => {
      const env = st[2]?.env ?? {};
      expect(env.GUARD_SHA).toBe(GUARD_SHA);
      expect(String(st[2]?.run)).toContain(
        '--commit "$GUARD_SHA" --lockfile pnpm-lock.yaml',
      );
      expect(env.MANIFEST_SHA256).toBe(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
        "${{ needs.hosted-check.outputs.manifest_sha256 }}",
      );
      expect(env.BUNDLE_SHA256).toBe(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
        "${{ needs.hosted-check.outputs.bundle_sha256 }}",
      );
    });
  });

  it("hosted-attach has contents: write, no key, and never overwrites a release asset", () => {
    const job = w.jobs["hosted-attach"];
    expect(job.permissions).toEqual({ contents: "write" });
    expect(JSON.stringify(job)).not.toContain("RELEASE_SIGNING_KEY");
    expect(JSON.stringify(job)).not.toContain("secrets.");
    expect(needs("hosted-attach")).toEqual(
      expect.arrayContaining(["hosted-guard", "hosted-check", "hosted-sign"]),
    );
    const run = steps("hosted-attach")
      .map((s) => s.run ?? "")
      .join("\n");
    expect(run).toContain("scripts/ci/assemble-release.ts");
    expect(run).toContain('--commit "$GUARD_SHA" --lockfile pnpm-lock.yaml');
    expect(run).toContain("gh release upload");
    expect(run).not.toContain("--clobber");
  });

  it("no job in the run has actions: write; every job sets permissions; only hosted-attach has contents: write", () => {
    expect(w.permissions ?? {}).toEqual({});
    for (const [name, job] of Object.entries(w.jobs) as [string, Step][]) {
      expect(job.permissions, name).toBeDefined();
      expect(job.permissions?.actions, name).not.toBe("write");
      expect(job.permissions?.contents === "write", name).toBe(
        name === "hosted-attach",
      );
    }
  });
});

describe("sign-release.ts imports only node:*", () => {
  const importsOf = (file: string): string[] =>
    [
      ...readFileSync(file, "utf8").matchAll(
        /\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\bimport\s+["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']/g,
      ),
    ].map((m) => (m[1] ?? m[2] ?? m[3] ?? m[4]) as string);
  const closure = (entry: string) => {
    const seen = new Set<string>();
    const bad: string[] = [];
    const visit = (f: string) => {
      if (seen.has(f)) return;
      seen.add(f);
      for (const spec of importsOf(f)) {
        if (spec.startsWith("node:")) continue;
        if (/^\.\.?\//.test(spec) && spec.endsWith(".ts")) {
          const p = resolve(dirname(f), spec);
          // Local imports stay inside scripts/ci.
          if (!p.startsWith(join(root, "scripts/ci/")))
            bad.push(`${f}: ${spec}`);
          else visit(p);
        } else bad.push(`${f}: ${spec}`);
      }
    };
    visit(entry);
    return { seen: [...seen], bad };
  };
  for (const entry of ["sign-release.ts", "assemble-release.ts"])
    it(entry, () => {
      const { seen, bad } = closure(join(root, "scripts/ci", entry));
      expect(bad).toEqual([]);
      expect(seen.length).toBeGreaterThan(1);
    });
  it("the scan catches a package import", () => {
    expect(
      importsOf(join(root, "scripts/ci/build-release-bundle.ts")).some(
        (s) => !s.startsWith("node:"),
      ),
    ).toBe(false);
    expect(importsOf(join(root, "scripts/check-ci.test.ts"))).toContain("yaml");
  });
});

describe("deploy-prod checks the release bundle before Upgrade", () => {
  const st = steps("deploy-prod");
  const at = (m: string) => st.findIndex((s) => (s.run ?? "").includes(m));
  it("builds the release bundle and runs check-no-test-hooks on it before the upgrade", () => {
    const build = at("build-release-bundle.ts");
    const check = at("pnpm check-no-test-hooks");
    const up = at("prod-setup.sh upgrade");
    expect(build).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(build);
    expect(up).toBeGreaterThan(check);
    for (const i of [build, check]) {
      expect(st[i]?.if).toBe("steps.guard.outputs.deploy == 'true'");
      expect(st[i]?.["continue-on-error"]).toBeUndefined();
      expect(JSON.stringify(st[i]?.env ?? {})).not.toContain("secrets.");
    }
    expect(st[build]?.run).toContain("--variant release");
  });
});

describe("build-release-bundle.ts", () => {
  it("takes --variant release|redline, defaulting to release", () => {
    const src = read("scripts/ci/build-release-bundle.ts");
    expect(src).toContain("--variant");
    expect(src).toMatch(/"release"/);
    expect(src).toMatch(/"redline"/);
  });
  it("the no-test-hooks CI job keeps its name and behavior", () => {
    // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
    const ci: any = parse(read(".github/workflows/ci.yml"));
    const runs = ci.jobs["no-test-hooks"].steps
      .map((s: Step) => s.run ?? "")
      .join("\n");
    expect(runs).toContain(
      'node --experimental-strip-types scripts/ci/build-release-bundle.ts "$RUNNER_TEMP/release-bundle"',
    );
    expect(runs).toContain(
      'pnpm check-no-test-hooks "$RUNNER_TEMP/release-bundle"',
    );
  });
});
