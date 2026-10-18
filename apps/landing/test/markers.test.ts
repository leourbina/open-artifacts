import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { selectTools } from "../src/lib/tools";

// Platform's release gate blocks the production deploy while dist/ contains
// "TODO" or "OA-UNRELEASED". These markers keep known stand-ins from shipping.
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const manifest = fileURLToPath(
  new URL("../../server/src/mcp/tool-manifest.json", import.meta.url),
);
const src = fileURLToPath(new URL("../src/content/docs/", import.meta.url));
const read = (p: string) => readFileSync(`${dist}${p}`, "utf8");

const B14 = "<!-- TODO(B14): fallback tool list -->";
const D6 = "<!-- TODO(D6): text wordmark -->";
const META = '<meta name="oa-status" content="OA-UNRELEASED">';

describe("release-gate markers", () => {
  it("puts the agent-file markers on their own lines at the top", () => {
    const hasManifest = existsSync(manifest);
    const top = hasManifest ? "" : `${B14}\nOA-UNRELEASED: B14 tool list\n\n`;
    for (const file of ["llms.txt", "llms-full.txt"]) {
      expect(read(file).startsWith(`${top}# Open Artifacts\n`), file).toBe(
        true,
      );
    }
  });

  it("flags every page as unreleased with one meta tag", () => {
    for (const page of [
      "index.html",
      "docs/setup/index.html",
      "docs/mcp-tools/index.html",
      "docs/security/index.html",
    ]) {
      const head = read(page).split("</head>")[0];
      expect(head.split(META).length - 1, page).toBe(1);
    }
  });

  it("uses the fallback only when there is no manifest", () => {
    expect(selectTools([]).isFallback).toBe(true);
    const tool = { name: "get_artifact", description: "Get one." };
    expect(selectTools([[tool]])).toEqual({ tools: [tool], isFallback: false });
  });

  it("marks the fallback tool list, and only while it's in use", () => {
    const hasManifest = existsSync(manifest);
    for (const page of [
      "index.html",
      "docs/mcp-tools/index.html",
      "llms.txt",
      "llms-full.txt",
    ])
      expect(read(page).includes(B14), page).toBe(!hasManifest);
    expect(read("docs/setup/index.html")).not.toContain(B14);
  });

  // The Welcome-URL TODO lives in setup.md's frontmatter only; the gate fails
  // on any "TODO" outside the known markers.
  it("keeps source-only TODOs out of the build", () => {
    expect(readFileSync(`${src}setup.md`, "utf8")).toContain(
      "TODO(B16 welcomeUrl)",
    );
    for (const page of [
      "docs/setup/index.html",
      "docs/setup.md",
      "llms.txt",
      "llms-full.txt",
    ])
      expect(read(page), page).not.toContain("welcomeUrl");
  });

  it("has no B16 marker now that the setup docs follow scripts/setup", () => {
    for (const page of ["docs/setup/index.html", "llms.txt", "llms-full.txt"])
      expect(read(page), page).not.toMatch(/TODO\(B16\)|B16 setup flags/);
  });

  it("marks the text wordmark on every page", () => {
    for (const page of ["index.html", "docs/setup/index.html"])
      expect(read(page)).toContain(D6);
  });
});
