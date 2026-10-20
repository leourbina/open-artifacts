// The root package.json version, the release-please manifest and the top
// CHANGELOG.md heading must all name the same version.
// Usage: node --experimental-strip-types scripts/ci/version-consistency.ts [dir]
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? ".";
const read = (f: string) => readFileSync(join(dir, f), "utf8");

const pkg = JSON.parse(read("package.json")).version;
const manifest = JSON.parse(read(".release-please-manifest.json"))["."];
// The first `## ` heading is the newest release: it must name the version.
const first = read("CHANGELOG.md")
  .split("\n")
  .find((l) => l.startsWith("## "));
const heading = first?.match(/^## \[?v?(\d+\.\d+\.\d+[^\]\s)]*)/)?.[1];

const problems: string[] = [];
if (pkg !== manifest)
  problems.push(
    `package.json version ${pkg} != .release-please-manifest.json "." ${manifest}`,
  );
if (heading !== pkg)
  problems.push(
    `CHANGELOG.md first \`## \` heading ${first ? `names ${heading ?? "no version"}` : "is missing"}, expected ${pkg}`,
  );

if (problems.length) {
  for (const p of problems) console.error(`version-consistency: ${p}`);
  process.exit(1);
}
console.log(`version-consistency: ${pkg}`);
