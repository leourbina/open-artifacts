import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(root, "scripts/ci/release-dry-run.sh");

function run(stubOutput: string, stubExit = 0) {
  const dir = mkdtempSync(join(tmpdir(), "rd-"));
  for (const f of [
    "release-please-config.json",
    ".release-please-manifest.json",
    "CHANGELOG.md",
    "package.json",
  ])
    cpSync(join(root, f), join(dir, f));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "out.txt"), stubOutput);
  writeFileSync(
    join(bin, "release-please"),
    `#!/usr/bin/env bash\ncat "${dir}/out.txt"\nexit ${stubExit}\n`,
  );
  chmodSync(join(bin, "release-please"), 0o755);
  const r = spawnSync("bash", [script], {
    encoding: "utf8",
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RD_ROOT: dir,
      BIOME_CMD: "true",
    },
  });
  return { ...r, dir };
}

const proposal = (v: string) =>
  `✔ Building pull requests\nWould open 1 pull requests\nfork: false\ntitle: chore(main): release ${v}\nbranch: x\n`;

describe("release-dry-run.sh", () => {
  it("passes for 0.2.0 and restores files", () => {
    const manifest = readFileSync(
      join(root, ".release-please-manifest.json"),
      "utf8",
    );
    const r = run(proposal("0.2.0"));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Proposed version: 0.2.0");
    expect(
      readFileSync(join(r.dir, ".release-please-manifest.json"), "utf8"),
    ).toBe(manifest);
  });
  it("passes when no release is proposed", () => {
    expect(run("Would open 0 pull requests\n").status).toBe(0);
  });
  it("fails for 1.0.0 while pre-1.0", () => {
    const r = run(proposal("1.0.0"));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("bump-minor-pre-major");
  });
  it("fails for unparseable output", () => {
    const r = run("garbage\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("could not parse");
  });
  it("fails for an invalid version", () => {
    expect(run(proposal("banana")).status).not.toBe(0);
  });
  it("fails when release-please exits non-zero", () => {
    expect(run("boom\n", 2).status).not.toBe(0);
  });
});

describe("ci.yml release-dry-run job", () => {
  const w = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
  const text = readFileSync(
    join(root, ".github/workflows/ci.yml"),
    "utf8",
  ).replaceAll("\\", "");
  it("exists, is path-filtered, and calls the script", () => {
    const job = w.jobs["release-dry-run"];
    expect(job).toBeDefined();
    const s = JSON.stringify(job);
    for (const p of [
      "release-please-config.json",
      ".release-please-manifest.json",
      ".github/workflows/release-please.yml",
      "biome.json",
      "CHANGELOG.md",
    ])
      expect(text).toContain(p);
    expect(s).toContain("scripts/ci/release-dry-run.sh");
    expect(s).toMatch(/release-please@\d+\.\d+\.\d+/);
  });
  it("is not a required check", () => {
    const required = ["lint", "typecheck", "test", "build", "e2e"];
    expect(required).not.toContain("release-dry-run");
    // no other job may depend on it
    for (const j of Object.values(w.jobs) as { needs?: unknown }[])
      expect(JSON.stringify(j.needs ?? [])).not.toContain("release-dry-run");
  });
});
