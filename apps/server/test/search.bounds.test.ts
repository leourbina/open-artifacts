// B17: extractText's per-entry work bounds (CPU budget), and that the
// index-based scanner still matches the old output.
import { describe, expect, it } from "vitest";
import {
  extractText,
  MAX_ENTITIES,
  MAX_SKIPS,
} from "../src/services/search.js";

const chunked = (s: string, size = 64 * 1024) => {
  const b = new TextEncoder().encode(s);
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < b.length; i += size)
        c.enqueue(b.subarray(i, i + size));
      c.close();
    },
  });
};

describe("extractText bounds", () => {
  it(`stops after ${MAX_SKIPS} comments/skipped elements`, async () => {
    const head = "<p>start</p>";
    const body = "<!--c--><script>x</script>".repeat(MAX_SKIPS);
    const html = `${head}${body}<p>tail</p>`;
    for (const t of [
      await extractText("html", html),
      await extractText("html", chunked(html)),
    ]) {
      expect(t.startsWith("start")).toBe(true);
      expect(t).not.toContain("tail");
    }
    // Under the cap, the tail is indexed.
    const small = `${head}${"<!--c-->".repeat(MAX_SKIPS - 1)}<p>tail</p>`;
    expect(await extractText("html", chunked(small))).toBe("start tail");
  });

  it(`decodes at most ${MAX_ENTITIES} entities; the rest stay raw`, async () => {
    const t = await extractText(
      "html",
      `<p>${"&lt;".repeat(MAX_ENTITIES + 2)}</p>`,
    );
    expect(t).toBe(`${"<".repeat(MAX_ENTITIES)}&lt;&lt;`);
  });

  it("whitespace: runs and non-space whitespace collapse to one space", async () => {
    expect(await extractText("html", "<p>a\tb\n\nc   d  e</p>")).toBe(
      "a b c d e",
    );
  });

  it("skips across chunk boundaries, case-insensitive closes", async () => {
    const html =
      "<p>a</p><SCRIPT>bad()</ScRiPt ><style>.x{}</style><p>b</p><!-- x --><p>c</p>";
    for (const size of [1, 3, 7, 64])
      expect(await extractText("html", chunked(html, size))).toBe("a b c");
  });
});
