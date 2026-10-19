import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LIMITS } from "@oa/shared";
import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatSeconds,
  LIMIT_PLACEHOLDERS,
} from "../src/lib/limits";

// Limits come from @oa/shared's LIMITS via {LIMIT_*} placeholders, so the
// docs can't drift when Backend changes one.
const src = fileURLToPath(new URL("../src/content/docs/", import.meta.url));
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const docs = readdirSync(src).filter((f) => f.endsWith(".md"));
const read = (dir: string, f: string) => readFileSync(`${dir}${f}`, "utf8");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("limits in the docs", () => {
  it("formats values like the docs write them", () => {
    expect(formatBytes(2 * 1024 * 1024)).toBe("2 MB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytes(512 * 1024)).toBe("512 KB");
    expect(formatSeconds(600)).toBe("10 minutes");
    expect(formatSeconds(3600)).toBe("1 hour");
    expect(formatSeconds(45)).toBe("45 seconds");
  });

  it("never hardcodes a value LIMITS owns", () => {
    for (const f of docs) {
      const text = read(src, f);
      for (const value of Object.values(LIMIT_PLACEHOLDERS))
        expect(text, `${f}: ${value}`).not.toMatch(
          new RegExp(`(?<![\\d.])${escapeRe(value)}`),
        );
    }
  });

  it("renders the current LIMITS values", () => {
    const page = (f: string) => read(dist, `docs/${f}`);
    expect(page("mcp-tools.md")).toContain(
      `capped at ${formatBytes(LIMITS.inlineBytes)} in total`,
    );
    expect(page("mcp-tools.md")).toContain(
      `A file can be up to ${formatBytes(LIMITS.fileBytes)}, and one publish up to ${formatBytes(LIMITS.publishBytes)}.`,
    );
    expect(page("mcp-tools.md")).toContain(
      `within about ${formatSeconds(LIMITS.indexDebounceMs / 1000)} of being published`,
    );
    expect(page("mcp-tools.md")).toContain(
      `Only the first ${formatBytes(LIMITS.indexTextBytes)} of an artifact's entry file is indexed`,
    );
    expect(page("runtime-api.md")).toContain(
      `| Document size | ${formatBytes(LIMITS.docBytes)} |`,
    );
    expect(page("runtime-api.md")).toContain(
      `| Writes per viewer | ${LIMITS.viewerWritesPerMin} per minute |`,
    );
    expect(page("security.md")).toContain(
      `expires after ${formatSeconds(LIMITS.signedUrlTtlSec)}`,
    );
    for (const f of [...docs, "../llms.txt", "../llms-full.txt"])
      expect(read(`${dist}docs/`, f), f).not.toContain("{LIMIT_");
    for (const f of ["mcp-tools/index.html", "runtime-api/index.html"])
      expect(read(`${dist}docs/`, f), f).not.toContain("{LIMIT_");
  });
});

describe("upload flow in llms.txt", () => {
  it("carries the large-file steps with the current limits", () => {
    const llms = read(dist, "llms.txt");
    expect(llms).toContain(
      `capped at ${formatBytes(LIMITS.inlineBytes)} in total`,
    );
    expect(llms).toContain("`create_upload`");
    expect(llms).toContain('{ "uploadId": "<uploadId>" }');
    expect(llms).toContain(
      `searchable with \`search_artifacts\` within about ${formatSeconds(LIMITS.indexDebounceMs / 1000)} of being published`,
    );
    expect(llms).toContain(
      `Only the first ${formatBytes(LIMITS.indexTextBytes)} of an artifact's entry file is indexed`,
    );
  });
});
