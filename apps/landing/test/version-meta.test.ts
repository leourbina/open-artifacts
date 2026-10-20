import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The post-deploy check (scripts/ci/verify-release.ts) reads this tag, so every
// page carries the root package.json version, invisibly.
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const root = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../package.json", import.meta.url)),
    "utf8",
  ),
) as { version: string };
const pages = [
  "index.html",
  "docs/setup/index.html",
  "docs/upgrade/index.html",
];

describe("oa-version meta", () => {
  for (const page of pages)
    it(`${page} carries the root package.json version`, () => {
      const html = readFileSync(`${dist}${page}`, "utf8");
      expect(html).toContain(
        `<meta name="oa-version" content="${root.version}">`,
      );
      expect(root.version).toMatch(/^\d+\.\d+\.\d+/);
    });

  it("is invisible head metadata: after charset (still first) and the viewport meta", () => {
    const html = readFileSync(`${dist}index.html`, "utf8");
    const head = html.split("<head>")[1]?.split("</head>")[0] ?? "";
    expect(head.trimStart().startsWith('<meta charset="utf-8">')).toBe(true);
    const at = (s: string) => head.indexOf(s);
    expect(at('name="viewport"')).toBeGreaterThan(-1);
    expect(at('name="oa-version"')).toBeGreaterThan(at('name="viewport"'));
    // only one, and never in the body
    expect(html.match(/name="oa-version"/g)).toHaveLength(1);
  });
});
