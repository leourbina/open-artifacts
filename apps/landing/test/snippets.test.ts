import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Agents and people paste these snippets verbatim, so they must be valid as-is.
const docs = fileURLToPath(new URL("../src/content/docs/", import.meta.url));
const pages = readdirSync(docs)
  .filter((f) => f.endsWith(".md"))
  .map((f) => ({ f, text: readFileSync(`${docs}${f}`, "utf8") }));

const blocks = (lang: string) =>
  pages.flatMap(({ f, text }) =>
    [
      ...text.matchAll(new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\`\`\``, "g")),
    ].map((m) => ({ f, body: m[1] ?? "" })),
  );

describe("doc snippets", () => {
  it("every json block parses (no comments; put file paths above the block)", () => {
    const json = blocks("json");
    expect(json.length).toBeGreaterThan(0);
    for (const { f, body } of json) {
      expect(() => JSON.parse(body), f).not.toThrow();
    }
  });

  it("single-quotes Authorization headers so the shell can't expand the token", () => {
    for (const { f, text } of pages) {
      expect(text, f).not.toMatch(/--header\s+"Authorization/);
    }
  });
});
