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
    expect(triggers(w).sort()).toEqual(["pull_request", "push"]);
    expect(w.on.push.branches).toEqual(["main"]);
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
  it("triggers on push to main with serialized staging concurrency", () => {
    expect(triggers(w)).toEqual(["push"]);
    expect(w.on.push.branches).toEqual(["main"]);
    expect(w.concurrency).toEqual({
      group: "staging",
      "cancel-in-progress": false,
    });
  });
  it("orders build -> migrate -> deploy -> smoke", () => {
    const j = w.jobs;
    expect(Object.keys(j)).toEqual(["build", "migrate", "deploy", "smoke"]);
    expect(j.migrate.needs).toContain("build");
    expect(j.deploy.needs).toContain("migrate");
    expect(j.smoke.needs).toContain("deploy");
  });
  it("migrates, deploys and smokes the right things", () => {
    const steps = (id: string) =>
      // biome-ignore lint/suspicious/noExplicitAny: untyped YAML
      JSON.stringify(w.jobs[id].steps.map((s: any) => s.run ?? s.with));
    expect(steps("migrate")).toContain(
      "d1 migrations apply open-artifacts-staging",
    );
    expect(steps("migrate")).toContain("--remote");
    expect(steps("deploy")).toContain("wrangler.staging.jsonc");
    expect(steps("deploy")).toContain("deploy");
    expect(steps("smoke")).toContain("staging.open-artifacts.com/healthz");
    expect(steps("smoke")).toContain("@oa/server smoke");
  });
  it("uses Cloudflare secrets", () => {
    const raw = read(".github/workflows/deploy-staging.yml");
    expect(raw).toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(raw).toContain("secrets.CLOUDFLARE_ACCOUNT_ID");
  });
});

describe("landing-preview.yml", () => {
  it("triggers on PRs touching apps/landing", () => {
    const w = wf("landing-preview.yml");
    expect(triggers(w)).toEqual(["pull_request"]);
    expect(w.on.pull_request.paths).toEqual(["apps/landing/**"]);
  });
});

describe("release-please", () => {
  it("workflow triggers on push to main with write permissions", () => {
    const w = wf("release-please.yml");
    expect(triggers(w)).toEqual(["push"]);
    expect(w.on.push.branches).toEqual(["main"]);
    expect(w.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
    });
    expect(read(".github/workflows/release-please.yml")).toContain(
      "googleapis/release-please-action@v4",
    );
  });
  it("config is release-type node, manifest starts at 0.0.0", () => {
    const c = JSON.parse(read("release-please-config.json"));
    expect(c.packages["."]["release-type"]).toBe("node");
    expect(c.packages["."]["bump-minor-pre-major"]).toBe(true);
    expect(JSON.parse(read(".release-please-manifest.json"))).toEqual({
      ".": "0.0.0",
    });
  });
});
