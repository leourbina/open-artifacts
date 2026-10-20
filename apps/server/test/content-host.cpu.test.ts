// Ported from the B10 adversarial review: injection must not walk every node.
// Wall-clock budgets: runs serially via vitest.cpu.config.ts (median of 7).
// Absolute times are reports (budget(): asserted only under test:cpu:strict);
// the gate is injection against a one-handler HTMLRewriter baseline.
import { describe, expect, it } from "vitest";
import { injectRuntime } from "../src/content/inject.js";
import { budget, calibrated, pairedMs, medianMs as time } from "./cpu-time.js";

const TAG = '<script src="/_oa/rt.js"></script>';
/** Local median of the one-handler rewrite of ~80 KB (dev laptop, 2026-10-20). */
const REWRITE_REF_MS = 1;
const html = (n: number) =>
  `<!doctype html><html><head><title>t</title></head><body>${"<i>a</i>".repeat(n)}</body></html>`;
const res = (b: BodyInit) =>
  new Response(b, { headers: { "content-type": "text/html" } });
const inj = (b: BodyInit) => injectRuntime(res(b), TAG).text();

/** A body delivered in small chunks, to exercise the 64 KB prefix buffer. */
function chunked(s: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(s);
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + size));
      i += size;
    },
  });
}

describe("injectRuntime CPU (global 10 ms budget)", () => {
  it("cost does not scale with element count once the runtime is injected", async ({
    annotate,
  }) => {
    const body = html(10_000); // ~80 KB, an ordinary page
    const t = await pairedMs(
      () =>
        new HTMLRewriter()
          .on("head", {
            element: (e) => {
              e.prepend("<script></script>", { html: true });
            },
          })
          .transform(res(body))
          .text(),
      () => inj(body),
    );
    await budget(annotate, "inject ~80 KB page", t.ms, 10);
    // Relative gate: a walk of every node would be many times the one-handler
    // baseline. The 5 ms slack over 3x it is scaled to the runner.
    await calibrated(annotate, "inject over 3x a one-handler rewrite", {
      ms: t.ms - 3 * t.base,
      baseMs: t.base,
      refMs: REWRITE_REF_MS,
      maxMs: 5,
    });
  });

  it("5 MB of HTML is injected in < 10 ms (report)", async ({ annotate }) => {
    const body = html(650_000);
    expect(body.length).toBeGreaterThan(5_000_000);
    let out = "";
    const ms = await time(async () => {
      out = await inj(body);
    });
    await budget(annotate, "inject 5 MB page", ms, 10);
    expect(out.length).toBe(body.length + TAG.length);
    expect(out.startsWith(`<!doctype html><html><head>${TAG}<title>`)).toBe(
      true,
    );
  });
});

describe("injectRuntime ordering: runtime first", () => {
  const cases: [string, string, string][] = [
    [
      "head",
      "<head><script>a</script></head>",
      `<head>${TAG}<script>a</script></head>`,
    ],
    [
      "HEAD uppercase + attrs",
      '<HTML><HEAD id="h"><script>a</script>',
      `<HTML><HEAD id="h">${TAG}<script>a</script>`,
    ],
    [
      "> inside quoted attr",
      '<head data-x="a>b"><script>a</script>',
      `<head data-x="a>b">${TAG}<script>a</script>`,
    ],
    [
      "<header> is not <head>",
      "<header>x</header>",
      `<head>${TAG}</head><header>x</header>`,
    ],
    [
      "head in a comment",
      "<!-- <head> --><p>x</p>",
      `<head>${TAG}</head><!-- <head> --><p>x</p>`,
    ],
    [
      "doctype + comment + html",
      "<!DOCTYPE html><!--c--><html lang=en><body>",
      `<!DOCTYPE html><!--c--><html lang=en><head>${TAG}</head><body>`,
    ],
    [
      "script before head",
      "<html><script>a</script><head></head>",
      `<html><head>${TAG}</head><script>a</script><head></head>`,
    ],
    [
      "script, no html",
      "<script>a</script>",
      `<head>${TAG}</head><script>a</script>`,
    ],
    ["doctype only", "<!doctype html>", `<!doctype html><head>${TAG}</head>`],
    ["text first", "hello <head>", `<head>${TAG}</head>hello <head>`],
    ["empty", "", `<head>${TAG}</head>`],
    [
      "head after body is ignored",
      "<body><head><script>a</script>",
      `<head>${TAG}</head><body><head><script>a</script>`,
    ],
    [
      "self-closing head",
      "<html><head/><script>a</script>",
      `<html><head/>${TAG}<script>a</script>`,
    ],
  ];
  for (const [name, input, want] of cases)
    it(name, async () => expect(await inj(input)).toBe(want));

  it("keeps a leading BOM first", async () => {
    const out = await inj("﻿<html><head></head>");
    expect(out).toBe(`﻿<html><head>${TAG}</head>`);
  });

  it("finds <head> across small chunks", async () => {
    const pre = `<!doctype html><!--${"x".repeat(5000)}--><html>`;
    const body = `${pre}<head><title>t</title></head><body>${"y".repeat(100_000)}</body>`;
    const out = await injectRuntime(res(chunked(body, 7)), TAG).text();
    expect(out).toBe(body.replace("<head>", `<head>${TAG}`));
  });

  it("gives up after 64 KB of prefix and injects at the best point", async () => {
    const body = `<html><!--${"x".repeat(70_000)}--><head></head>`;
    const out = await inj(body);
    expect(out).toBe(`<html><head>${TAG}</head>${body.slice(6)}`);
  });

  it("preserves non-ASCII bytes exactly", async () => {
    const body = "<head><title>héllo ✓ 日本</title></head>";
    expect(await inj(body)).toBe(body.replace("<head>", `<head>${TAG}`));
  });

  it("null tag leaves the response untouched", async () => {
    const r = res("<p>x</p>");
    expect(injectRuntime(r, null)).toBe(r);
  });
});
