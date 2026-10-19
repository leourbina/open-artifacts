import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Landing v2 sections: decorative motion is aria-hidden, and the same story is
// in real text next to it. Runs against the built site.
const index = readFileSync(
  fileURLToPath(new URL("../dist/index.html", import.meta.url)),
  "utf8",
);
const section = (attr: string) => {
  const start = index.indexOf(attr);
  expect(start, attr).toBeGreaterThan(-1);
  return index.slice(start, index.indexOf("</figure>", start));
};

describe("landing sections", () => {
  it("the agent wiring is decorative, with a real caption", () => {
    const wire = section("data-wire");
    expect(wire).toMatch(/class="wire-stage"[^>]*aria-hidden="true"/);
    for (const agent of [
      "Claude Code",
      "Codex",
      "Cursor",
      "OpenCode",
      "Any MCP client",
    ])
      expect(wire).toContain(`>${agent}</li>`);
    expect(wire).toMatch(/<figcaption[^>]*>\s*Any AI agent sends/);
  });

  it("the chat demo has six keyboard tabs and real prompt text", () => {
    const tabs = index.match(/<button[^>]*role="tab"[^>]*>/g) ?? [];
    expect(tabs).toHaveLength(6);
    expect(index).toMatch(/role="tablist"[^>]*aria-label="Examples"/);
    expect(index).toMatch(/id="demo-panel"[^>]*role="tabpanel"/);
    expect(
      /<span class="sr-only"[^>]*>publish this as an artifact<\/span>/.test(
        index,
      ),
    ).toBe(true);
    expect(index.match(/data-k="/g)).toHaveLength(16);
  });

  it("the hero keeps the library screenshot", () => {
    expect(index).toMatch(/class="frame hero-shot"/);
  });
});
