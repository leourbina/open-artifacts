// B17: extractText's per-entry work bounds (CPU budget), and that the
// index-based scanner still matches the old output.
import { describe, expect, it } from "vitest";
import {
  extractText,
  INDEX_INPUT_BYTES,
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

  it(`reads and extracts at most the first ${INDEX_INPUT_BYTES} bytes`, async () => {
    expect(INDEX_INPUT_BYTES).toBe(128 * 1024);
    // Markdown is raw: exactly the first INDEX_INPUT_BYTES bytes, whatever the chunking.
    const md = "abcdefgh".repeat(40 * 1024); // 320 KB
    for (const size of [1000, 64 * 1024, 100 * 1024, 512 * 1024])
      expect(await extractText("markdown", chunked(md, size))).toBe(
        md.slice(0, INDEX_INPUT_BYTES),
      );
    // HTML: text past the cap is never indexed, even when the output cap isn't reached.
    const html = `<p>head</p>${"<i></i>".repeat(INDEX_INPUT_BYTES / 7)}<p>past</p>`;
    const t = await extractText("html", chunked(html));
    expect(t).toBe("head");
    // The stream is cancelled at the cap: no more than one chunk past it is pulled.
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(16 * 1024).fill(0x61);
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += chunk.byteLength;
        c.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    expect((await extractText("code", endless)).length).toBe(INDEX_INPUT_BYTES);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(
      INDEX_INPUT_BYTES + 2 * chunk.byteLength,
    );
  });
});
