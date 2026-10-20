import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(root, "scripts/ci/version-consistency.ts");

function check(pkg: string, manifest: string, changelog: string) {
  const dir = mkdtempSync(join(tmpdir(), "vc-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: pkg }));
  writeFileSync(
    join(dir, ".release-please-manifest.json"),
    JSON.stringify({ ".": manifest }),
  );
  writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  const r = spawnSync(
    "node",
    ["--experimental-strip-types", "--no-warnings", script, dir],
    { encoding: "utf8" },
  );
  return { code: r.status, err: r.stderr };
}
const LOG = (v: string) =>
  `# Changelog\n\n## [${v}](https://example.com/compare/v0.0.1...v${v}) (2026-10-20)\n\n### Features\n`;

describe("version-consistency.ts", () => {
  it("passes when package.json, the manifest and the CHANGELOG agree", () => {
    expect(check("0.4.0", "0.4.0", LOG("0.4.0")).code).toBe(0);
  });
  it("fails when the manifest differs", () => {
    expect(check("0.4.0", "0.3.0", LOG("0.4.0")).code).toBe(1);
  });
  it("fails when the CHANGELOG top heading names another version", () => {
    const r = check("0.5.0", "0.5.0", LOG("0.4.0"));
    expect(r.code).toBe(1);
    expect(r.err).toContain("expected 0.5.0");
  });
  it("this repo is consistent", () => {
    const r = spawnSync(
      "node",
      ["--experimental-strip-types", "--no-warnings", script, root],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
  });
});
