// extractText wall-clock budgets (moved from search.test / b8.breaker, whose
// deterministic byte bounds stay there). Runs serially via vitest.cpu.config.ts.
import { describe, expect, it } from "vitest";
import { extractText } from "../src/services/search.js";
import { medianMs } from "./cpu-time.js";

/** 16 KB chunks of pre-encoded bytes (encoding stays outside the timing). */
const stream = (b: Uint8Array, n = 16 * 1024) => {
  let off = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (off >= b.length) return c.close();
      c.enqueue(b.slice(off, off + n));
      off += n;
    },
  });
};
const timed = (html: string) => {
  const b = new TextEncoder().encode(html);
  return medianMs(() => extractText("html", stream(b)));
};

describe("extractText CPU", () => {
  it("indexes a 200k-char HTML entry in ≤ 100 ms", async () => {
    const para =
      "<p>lorem ipsum <b>dolor</b> sit amet</p><script>x()</script>\n";
    const html = para.repeat(Math.ceil(200_000 / para.length));
    expect(html.length).toBeGreaterThanOrEqual(200_000);
    const text = await extractText("html", new Response(html).body as never);
    expect(text.startsWith("lorem ipsum dolor sit amet")).toBe(true);
    expect(text).not.toContain("x()");
    // HTMLRewriter text handlers measured ~500 ms here; regress loudly.
    const ms = await medianMs(() =>
      extractText("html", new Response(html).body as never),
    );
    expect(ms).toBeLessThanOrEqual(100);
  });

  it("all-markup HTML (8 MB comment) stops in ≤ 100 ms", async () => {
    expect(
      await timed(`<!--${"a".repeat(8 * 1024 * 1024)}`),
    ).toBeLessThanOrEqual(100);
  });

  it("unterminated tag openers (<a<a<a…) stay linear: ≤ 100 ms", async () => {
    expect(await timed("<a".repeat(1_000_000))).toBeLessThanOrEqual(100);
  });

  it("8 MB of inline tags: ≤ 100 ms", async () => {
    expect(await timed("<b>".repeat(2_800_000))).toBeLessThanOrEqual(100);
  });
});
