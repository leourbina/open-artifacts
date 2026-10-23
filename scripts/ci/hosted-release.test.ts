// T3b: the hosted release jobs in release-please.yml (guard, build, check,
// sign and attach per env) and hosted-floor.yml. The signing key never
// shares a job with installed code.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const w: any = parse(read(".github/workflows/release-please.yml"));
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const fw: any = parse(read(".github/workflows/hosted-floor.yml"));
const ENVS = ["staging", "prod"] as const;
const HOSTED = [
  "hosted-guard",
  "hosted-build",
  "hosted-check",
  "hosted-sign-staging",
  "hosted-sign-prod",
  "hosted-attach-staging",
  "hosted-attach-prod",
];
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
type Step = Record<string, any>;
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const stepsOf = (wf: any, job: string): Step[] => wf.jobs[job].steps;
const steps = (job: string) => stepsOf(w, job);
const needs = (job: string): string[] => [w.jobs[job].needs ?? []].flat();
const runOf = (st: Step[]) => st.map((s) => s.run ?? "").join("\n");
const SHA_PIN =
  /^(actions\/(checkout|download-artifact|upload-artifact|setup-node)|pnpm\/action-setup)@[0-9a-f]{40}$/;
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
const GUARD_SHA = "${{ needs.hosted-guard.outputs.sha }}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
const TAG = "${{ needs.hosted-guard.outputs.tag }}";
const NVMRC_MAJOR = read(".nvmrc").trim().split(".")[0];
// Any invocation (the lockfile path "pnpm-lock.yaml" is not one).
const INSTALL = /(^|[\s;|&(`])(pnpm|npm|npx|corepack|yarn)(?=$|[\s;|&)`])/m;

/**
 * Decision 4 as amended (fix round 2, L1): a key job runs only checkout,
 * setup-node and (for sign) download-artifact, all pinned by SHA; setup-node
 * takes an EXACT 22.x.y literal matching .nvmrc's major, no version file.
 */
function keyJobShape(st: Step[], o: { download: boolean; script: string }) {
  const uses = st.map((s) => s.uses).filter(Boolean) as string[];
  expect(uses.map((u) => u.split("@")[0])).toEqual([
    "actions/checkout",
    "actions/setup-node",
    ...(o.download ? ["actions/download-artifact"] : []),
  ]);
  for (const u of uses)
    expect(u).toMatch(
      /^actions\/(checkout|setup-node|download-artifact)@[0-9a-f]{40}$/,
    );
  expect(st).toHaveLength(uses.length + 1);
  expect(st[0]?.with?.["persist-credentials"]).toBe(false);
  const node = st[1]?.with ?? {};
  expect(Object.keys(node)).toEqual(["node-version"]);
  expect(String(node["node-version"])).toMatch(/^\d+\.\d+\.\d+$/);
  expect(String(node["node-version"]).split(".")[0]).toBe(NVMRC_MAJOR);
  const last = st.at(-1) as Step;
  expect(last.uses).toBeUndefined();
  for (const s of st) expect(s.run ?? "").not.toMatch(INSTALL);
  const withKey = st.filter((s) =>
    JSON.stringify(s).includes("RELEASE_SIGNING_KEY"),
  );
  expect(withKey).toEqual([last]);
  expect(last.env?.RELEASE_SIGNING_KEY).toBe(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    "${{ secrets.RELEASE_SIGNING_KEY }}",
  );
  const run = String(last.run);
  expect(run).toMatch(
    new RegExp(
      `printf '%s' "\\$RELEASE_SIGNING_KEY" \\| node --experimental-strip-types scripts/ci/${o.script} `,
    ),
  );
  expect(run.match(/RELEASE_SIGNING_KEY/g)).toHaveLength(1);
  expect(run).not.toMatch(/set -x|set -o xtrace|--key/);
  expect(JSON.stringify(st.slice(0, -1))).not.toContain("secrets.");
  expect(JSON.stringify(st)).not.toMatch(/CLOUDFLARE_/);
}

describe("release-please.yml hosted jobs", () => {
  it("has the hosted jobs, sign and attach split per env (no matrix merge)", () => {
    expect(Object.keys(w.jobs)).toEqual(expect.arrayContaining(HOSTED));
    for (const n of Object.keys(w.jobs))
      if (n.startsWith("hosted-")) expect(HOSTED, n).toContain(n);
    for (const n of HOSTED) expect(w.jobs[n].strategy, n).toBeUndefined();
  });

  describe("hosted-guard", () => {
    const job = w.jobs["hosted-guard"];
    const run = runOf(steps("hosted-guard"));
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
    it("resolves the tag to a commit once, behind or identical to main's branch SHA, matching package.json", () => {
      expect(run.match(/git\/ref\/tags\//g)).toHaveLength(1);
      // L4: main is read as the branch ref, never the bare (tag-shadowable) name.
      expect(run).toContain('gh api "repos/$REPO/git/ref/heads/main"');
      expect(run).toContain('compare/$main_sha...$sha"');
      expect(run).not.toContain("compare/main...");
      expect(run).toMatch(/behind\|identical|identical\|behind/);
      expect(run).toContain("contents/package.json?ref=$sha");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell expansion
      expect(run).toContain('"${TAG#v}"');
      expect(run).toContain("isPrerelease");
      expect(run).not.toContain("${{");
      expect(job.outputs.sha).toMatch(/steps\.\w+\.outputs\.sha/);
    });
    it("L5: the SHA is the release commit (target_commitish when a SHA, and package.json's version changed in it)", () => {
      expect(run).toContain('releases/tags/$TAG"');
      expect(run).toContain("target_commitish");
      expect(run).toContain(".parents[0].sha");
      expect(run).toContain("contents/package.json?ref=$parent");
      expect(run).toMatch(/\[ "\$prev" != "\$version" \]/);
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
    const run = runOf(steps("hosted-build"));
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
    const run = runOf(steps("hosted-check"));
    expect(run).toContain("scripts/ci/check-hosted-release.ts");
    expect(run).toMatch(
      /pnpm check-no-test-hooks "\$RUNNER_TEMP\/hosted\/release"/,
    );
    expect(Object.keys(job.outputs).sort()).toEqual([
      "bundle_sha256",
      "manifest_sha256",
    ]);
  });

  for (const env of ENVS)
    describe(`hosted-sign-${env}`, () => {
      const name = `hosted-sign-${env}`;
      const job = w.jobs[name];
      const st = steps(name);
      it(`runs in environment hosted-${env}, needing build and check, read-only, serialized per tag`, () => {
        expect(job.environment).toBe(`hosted-${env}`);
        expect(needs(name)).toEqual(
          expect.arrayContaining([
            "hosted-guard",
            "hosted-build",
            "hosted-check",
          ]),
        );
        expect(job.permissions).toEqual({ contents: "read" });
        expect(job.concurrency).toEqual({
          group: `hosted-sign-${env}-${TAG}`,
          "cancel-in-progress": false,
        });
        expect(job.env).toBeUndefined();
      });
      it("has the key-job shape: checkout, exact setup-node, download-artifact, node sign-release.ts", () => {
        keyJobShape(st, { download: true, script: "sign-release.ts" });
      });
      it("signs only its own env and outputs only its own names", () => {
        const env2 = st.at(-1)?.env ?? {};
        expect(env2.SIGN_ENV).toBe(env);
        expect(env2.GUARD_SHA).toBe(GUARD_SHA);
        expect(String(st.at(-1)?.run)).toContain(
          '--commit "$GUARD_SHA" --lockfile pnpm-lock.yaml',
        );
        expect(env2.MANIFEST_SHA256).toBe(
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
          "${{ needs.hosted-check.outputs.manifest_sha256 }}",
        );
        expect(env2.BUNDLE_SHA256).toBe(
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
          "${{ needs.hosted-check.outputs.bundle_sha256 }}",
        );
        const variants = env === "prod" ? ["release"] : ["release", "redline"];
        expect(Object.keys(job.outputs).sort()).toEqual(
          variants
            .flatMap((v) =>
              ["signature", "tar_sha256", "record_sha256"].map(
                (k) => `${env}_${v}_${k}`,
              ),
            )
            .sort(),
        );
      });
    });

  for (const env of ENVS)
    it(`hosted-attach-${env}: contents: write, no key, only its own sign job's outputs, refuses existing assets`, () => {
      const name = `hosted-attach-${env}`;
      const job = w.jobs[name];
      const other = env === "prod" ? "staging" : "prod";
      expect(job.permissions).toEqual({ contents: "write" });
      expect(JSON.stringify(job)).not.toContain("RELEASE_SIGNING_KEY");
      expect(JSON.stringify(job)).not.toContain("secrets.");
      expect(needs(name)).toEqual(
        expect.arrayContaining([
          "hosted-guard",
          "hosted-check",
          `hosted-sign-${env}`,
        ]),
      );
      expect(needs(name)).not.toContain(`hosted-sign-${other}`);
      expect(JSON.stringify(job)).not.toContain(`hosted-sign-${other}`);
      expect(job.concurrency).toEqual({
        group: `hosted-attach-${env}-${TAG}`,
        "cancel-in-progress": false,
      });
      const st = steps(name);
      const run = runOf(st);
      expect(run).toContain("scripts/ci/assemble-release.ts");
      expect(run).toContain(`--env ${env}`);
      expect(run).toContain('--commit "$GUARD_SHA" --lockfile pnpm-lock.yaml');
      // L8: refuses when any of this env's assets is already on the release.
      expect(run).toContain("gh release view");
      expect(run).toContain(`oa-release-${env}-`);
      expect(run.indexOf("gh release view")).toBeLessThan(
        run.indexOf("gh release upload"),
      );
      expect(run).toContain("gh release upload");
      expect(run).not.toContain("--clobber");
      const node = st.filter((x) =>
        String(x.uses ?? "").startsWith("actions/setup-node@"),
      );
      expect(node).toHaveLength(1);
    });

  it("no job in the run has actions: write; every job sets permissions; only the attach jobs have contents: write", () => {
    expect(w.permissions ?? {}).toEqual({});
    for (const [name, job] of Object.entries(w.jobs) as [string, Step][]) {
      expect(job.permissions, name).toBeDefined();
      expect(job.permissions?.actions, name).not.toBe("write");
      expect(job.permissions?.contents === "write", name).toBe(
        name.startsWith("hosted-attach-"),
      );
    }
  });
});

describe("hosted-floor.yml (H1)", () => {
  it("is dispatch-only with validated-shape inputs and no workflow-wide grant", () => {
    expect(Object.keys(fw.on)).toEqual(["workflow_dispatch"]);
    const inp = fw.on.workflow_dispatch.inputs;
    expect(inp.env.type).toBe("choice");
    expect(inp.env.options).toEqual(["staging", "prod"]);
    for (const k of ["seq", "min_version", "revoked"])
      expect(inp[k], k).toBeDefined();
    expect(fw.permissions).toEqual({});
  });
  it("floor-guard: main only, branch SHA, no secrets, read-only", () => {
    const job = fw.jobs["floor-guard"];
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(job.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(job.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(job)).not.toContain("secrets.");
    const run = runOf(stepsOf(fw, "floor-guard"));
    expect(run).toContain('gh api "repos/$REPO/git/ref/heads/main"');
    expect(run).not.toContain("${{");
    expect(job.outputs.sha).toMatch(/steps\.\w+\.outputs\.sha/);
  });
  it("hosted-floor: the key-job shape, environment hosted-<env>, no install", () => {
    const job = fw.jobs["hosted-floor"];
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(job.environment).toBe("hosted-${{ inputs.env }}");
    expect([job.needs].flat()).toEqual(["floor-guard"]);
    expect(job.permissions).toEqual({ contents: "read" });
    const st = stepsOf(fw, "hosted-floor");
    keyJobShape(st, { download: false, script: "sign-floor.ts" });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(st[0]?.with?.ref).toBe("${{ needs.floor-guard.outputs.sha }}");
    const run = String(st.at(-1)?.run);
    expect(run).not.toContain("${{");
    for (const f of ["--env", "--seq", "--min-version", "--revoked"])
      expect(run).toContain(f);
    expect(Object.keys(job.outputs).sort()).toEqual([
      "floor_record_sha256",
      "floor_signature",
    ]);
  });
  it("hosted-floor-upload: no key, rebuilds with --assemble, uploads a workflow artifact, never a release asset", () => {
    const job = fw.jobs["hosted-floor-upload"];
    expect(job.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(job)).not.toContain("secrets.");
    expect([job.needs].flat()).toEqual(
      expect.arrayContaining(["floor-guard", "hosted-floor"]),
    );
    const st = stepsOf(fw, "hosted-floor-upload");
    for (const s of st) if (s.uses) expect(s.uses).toMatch(SHA_PIN);
    const run = runOf(st);
    expect(run).toContain("scripts/ci/sign-floor.ts");
    expect(run).toContain("--assemble");
    expect(run).not.toContain("gh release");
    const up = st.filter((s) =>
      String(s.uses ?? "").startsWith("actions/upload-artifact"),
    );
    expect(up).toHaveLength(1);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(up[0]?.with?.name).toBe("floor-${{ inputs.env }}-${{ inputs.seq }}");
  });
  it("docs/ops/hosted.md names the hosted-floor job in the checklists", () => {
    const doc = read("docs/ops/hosted.md");
    const first = doc.slice(doc.indexOf("### First-create checklist"));
    expect(first).toContain("hosted-floor");
    const rev = doc.slice(doc.indexOf("### Release checklist"));
    expect(rev).toContain("hosted-floor");
  });
});

describe("the key jobs' scripts import only node:* (L3: no dynamic loading)", () => {
  const FORBIDDEN =
    /\bimport\s*\(\s*[^"'\s)]|\bcreateRequire\b|\brequire\s*\(|["']node:(child_process|module|worker_threads|vm)["']|\bprocess\.dlopen\b/;
  const importsOf = (src: string): string[] =>
    [
      ...src.matchAll(
        /\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g,
      ),
    ].map((m) => (m[1] ?? m[2] ?? m[3]) as string);
  const closure = (entry: string) => {
    const seen = new Set<string>();
    const bad: string[] = [];
    const visit = (f: string) => {
      if (seen.has(f)) return;
      seen.add(f);
      const src = readFileSync(f, "utf8");
      const hit = FORBIDDEN.exec(src);
      if (hit) bad.push(`${f}: ${hit[0]}`);
      for (const spec of importsOf(src)) {
        if (spec.startsWith("node:")) continue;
        if (/^\.\.?\//.test(spec) && spec.endsWith(".ts")) {
          const p = resolve(dirname(f), spec);
          if (!p.startsWith(join(root, "scripts/ci/")))
            bad.push(`${f}: ${spec}`);
          else visit(p);
        } else bad.push(`${f}: ${spec}`);
      }
    };
    visit(entry);
    return { seen: [...seen], bad };
  };
  for (const entry of [
    "sign-release.ts",
    "assemble-release.ts",
    "sign-floor.ts",
  ])
    it(entry, () => {
      const { seen, bad } = closure(join(root, "scripts/ci", entry));
      expect(bad).toEqual([]);
      expect(seen.length).toBeGreaterThan(1);
    });
  it("the scan flags a package import, a dynamic import, require and child_process", () => {
    const d = mkdtempSync(join(tmpdir(), "oa-scan-"));
    for (const [n, src] of [
      ["pkg.ts", 'import { parse } from "yaml";\n'],
      ["dyn.ts", "const m = await import(spec);\n"],
      ["req.ts", 'import { createRequire } from "node:module";\n'],
      ["cjs.ts", 'const x = require("fs");\n'],
      ["cp.ts", 'import { spawn } from "node:child_process";\n'],
      ["dl.ts", "process.dlopen(m, p);\n"],
      ["local.ts", 'import { x } from "./pkg.ts";\n'],
    ] as const) {
      writeFileSync(join(d, n), src);
      expect(closure(join(d, n)).bad.length, n).toBeGreaterThan(0);
    }
    writeFileSync(
      join(d, "ok.ts"),
      'import { createHash } from "node:crypto";\n',
    );
    expect(closure(join(d, "ok.ts")).bad).toEqual([]);
    // build-release-bundle.ts loads a package dynamically: flagged.
    expect(
      closure(join(root, "scripts/ci/build-release-bundle.ts")).bad.length,
    ).toBeGreaterThan(0);
  });
});

describe("docs/ops/hosted.md first-create checklist", () => {
  it("applies the platform D1 migrations, the floor one included, before the first create", () => {
    const doc = read("docs/ops/hosted.md");
    const at = doc.indexOf("### First-create checklist");
    expect(at).toBeGreaterThan(-1);
    const section = doc.slice(at, doc.indexOf("\n## ", at) >>> 0 || undefined);
    expect(section).toContain("0001_installs.sql");
    expect(section).toContain("0002_release_floor.sql");
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
  it("L10: the upgrade itself runs check-no-test-hooks on the bundle it deploys", () => {
    const up = st[at("prod-setup.sh upgrade")];
    expect(up?.env?.OA_CHECK_NO_TEST_HOOKS).toBe("1");
  });
});

describe("ci.yml no-test-hooks job", () => {
  // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
  const ci: any = parse(read(".github/workflows/ci.yml"));
  const st: Step[] = ci.jobs["no-test-hooks"].steps;
  it("keeps its name and behavior", () => {
    const runs = runOf(st);
    expect(runs).toContain(
      'node --experimental-strip-types scripts/ci/build-release-bundle.ts "$RUNNER_TEMP/release-bundle"',
    );
    expect(runs).toContain(
      'pnpm check-no-test-hooks "$RUNNER_TEMP/release-bundle"',
    );
  });
  it("N5: runs the real-build pin test, required (never skipped), behind the same release-only gate", () => {
    const pin = st.find((s) => (s.run ?? "").includes('-t "real build"'));
    expect(pin?.run).toContain(
      "pnpm --filter @oa/provision exec vitest run test/release-t3b.test.ts",
    );
    expect(pin?.env?.OA_REQUIRE_REAL_BUILD).toBe("1");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(pin?.if).toBe("${{ steps.ro.outputs.release_only != 'true' }}");
    const check = st.findIndex((s) =>
      (s.run ?? "").includes("pnpm check-no-test-hooks"),
    );
    expect(st.indexOf(pin as Step)).toBeGreaterThan(check);
  });
});

describe("build-release-bundle.ts", () => {
  it("takes --variant release|redline, defaulting to release", () => {
    const src = read("scripts/ci/build-release-bundle.ts");
    expect(src).toContain("--variant");
    expect(src).toMatch(/"release"/);
    expect(src).toMatch(/"redline"/);
  });
});
