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
const read = (p: string) => readFileSync(`${dist}${p}`, "utf8");

const B14 = "<!-- TODO(B14): fallback tool list -->";
const B16 = "<!-- TODO(B16): setup flags unverified -->";
const D6 = "<!-- TODO(D6): text wordmark -->";
const META = '<meta name="oa-status" content="OA-UNRELEASED">';

describe("release-gate markers", () => {
  it("puts the agent-file markers on their own lines at the top", () => {
    const hasManifest = existsSync(manifest);
    const todos = [...(hasManifest ? [] : [B14]), B16]
      .map((m) => `${m}\n`)
      .join("");
    const labels = [
      ...(hasManifest ? [] : ["B14 tool list"]),
      "B16 setup flags",
    ];
    const status = `OA-UNRELEASED: ${labels.join(", ")}\n\n`;
    for (const file of ["llms.txt", "llms-full.txt"]) {
      expect(
        read(file).startsWith(`${todos}${status}# Open Artifacts\n`),
        file,
      ).toBe(true);
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

  it("marks the unverified setup flags", () => {
    for (const page of ["docs/setup/index.html", "llms.txt", "llms-full.txt"])
      expect(read(page), page).toContain(B16);
    expect(read("index.html")).not.toContain(B16);
  });

  it("marks the text wordmark on every page", () => {
    for (const page of ["index.html", "docs/setup/index.html"])
      expect(read(page)).toContain(D6);
  });
});
