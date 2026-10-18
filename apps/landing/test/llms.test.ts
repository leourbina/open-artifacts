import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REPO_URL } from "@oa/shared";
import { describe, expect, it } from "vitest";

// Runs against the built site: `pnpm test` builds first.
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const manifest = fileURLToPath(
  new URL("../../server/src/mcp/tool-manifest.json", import.meta.url),
);
const fallback = fileURLToPath(
  new URL("../src/data/tools.fallback.json", import.meta.url),
);

const llms = readFileSync(`${dist}llms.txt`, "utf8");
const tools: { name: string }[] = JSON.parse(
  readFileSync(existsSync(manifest) ? manifest : fallback, "utf8"),
);

describe("llms.txt", () => {
  it("has the exact headings, in order", () => {
    expect(llms.startsWith("# Open Artifacts\n\n")).toBe(true);
    const headings = llms.match(/^##? .+$/gm);
    expect(headings).toEqual([
      "# Open Artifacts",
      "## Set up Open Artifacts for your user",
      "## Update an existing install",
      "## Connect another agent",
      "## Tools",
      "## Docs",
    ]);
  });

  it("lists every MCP tool", () => {
    expect(tools.length).toBeGreaterThan(0);
    for (const { name } of tools) expect(llms).toContain(`\`${name}\``);
  });

  it("runs setup non-interactively", () => {
    expect(llms).toContain("pnpm oa:setup --json");
  });

  it("names the repo once, as the clone source of the latest tag", () => {
    expect(llms.split(REPO_URL).length - 1).toBe(1);
    expect(llms).toContain(`REPO=${REPO_URL}\n`);
    expect(llms).toContain('git clone --depth 1 --branch "$TAG" "$REPO"');
  });

  it("picks the latest release tag, with or without a prefix", () => {
    // The pipeline after `git ls-remote`, shared by setup and upgrade.
    const pipe = llms.match(/"\$REPO" '\*v\*'([\s\S]*?)\)\n/)?.[1] ?? "";
    expect(pipe).toContain("sort -rV");
    expect(llms.split(`origin '*v*'${pipe})`).length - 1).toBe(1);
    const latest = (...tags: string[]) =>
      execFileSync("sh", [
        "-c",
        `printf '%s\\n' ${tags.map((t) => `'x refs/tags/${t}'`).join(" ")}${pipe}`,
      ])
        .toString()
        .trim();
    expect(latest("v0.2.0", "open-artifacts-v0.2.0")).toMatch(
      /^(open-artifacts-)?v0\.2\.0$/,
    );
    expect(
      latest("v0.2.0", "open-artifacts-v0.10.0", "v0.9.1", "v1.0.0-rc.1", "x"),
    ).toBe("open-artifacts-v0.10.0");
  });

  it("has no link that 404s in the built site", () => {
    const urls = [
      ...llms.matchAll(/https:\/\/open-artifacts\.com(\/[^\s)`"]*)?/g),
    ];
    expect(urls.length).toBeGreaterThan(0);
    for (const [, path = "/"] of urls) {
      const file = path.endsWith("/") ? `${path}index.html` : path;
      expect(existsSync(`${dist}${file.slice(1)}`), path).toBe(true);
    }
  });
});
