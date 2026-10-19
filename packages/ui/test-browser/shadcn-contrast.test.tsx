// Real-browser a11y for the shadcn components: compiles Tailwind with the
// Studio tokens, renders every variant on bg and on surface under
// <html data-theme>, and runs axe (incl. color-contrast) in Chromium. Also
// tabs through every control and measures its focus outline. jsdom can't do
// either. Run: pnpm --filter @oa/ui test:browser
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import axe from "axe-core";
import { type Browser, chromium } from "playwright";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "tailwindcss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cases } from "../test/shadcn-fixtures";

const pkg = resolve(import.meta.dirname, "..");
const themePath = `${pkg}/src/shadcn/theme.css`;

async function buildCss() {
  const resolveCss = (id: string) => {
    const file = resolve(pkg, "node_modules", id, "package.json");
    const { exports, style } = JSON.parse(readFileSync(file, "utf8"));
    return resolve(dirname(file), exports?.["."]?.style ?? style);
  };
  const compiler = await compile(readFileSync(themePath, "utf8"), {
    base: dirname(themePath),
    from: themePath,
    loadStylesheet: async (id: string, base: string) => {
      const path = id.startsWith(".") ? resolve(base, id) : resolveCss(id);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  // Candidates: every token in the component sources and the fixtures;
  // Tailwind ignores the ones that aren't classes.
  const sources = [
    ...readdirSync(`${pkg}/src/shadcn/ui`).map(
      (f) => `${pkg}/src/shadcn/ui/${f}`,
    ),
    `${pkg}/test/shadcn-fixtures.tsx`,
    import.meta.filename,
  ].map((f) => readFileSync(f, "utf8"));
  const candidates = new Set(sources.join(" ").split(/[\s"'`{}(),;]+/));
  // The tokens' Google Fonts @import would need the network; fonts don't
  // change contrast math.
  const tokens = readFileSync(`${pkg}/src/tokens/tokens.css`, "utf8").replace(
    /@import url\([^)]*\);/,
    "",
  );
  return tokens + compiler.build([...candidates]);
}

const markup = Object.values(cases)
  .map((el) => `<div class="py-1">${renderToStaticMarkup(el)}</div>`)
  .join("");
const page = (theme: string, css: string) => `<!doctype html>
<html lang="en" data-theme="${theme}"><head><title>shadcn core</title>
<style>${css}</style>
<!-- Measure settled styles: transition-all would animate the outline in. -->
<style>*, *::before, *::after { transition: none !important; }</style></head>
<body class="bg-background text-foreground font-sans">
  <main>
    <section class="p-4">${markup}</section>
    <section class="bg-card p-4">${markup}</section>
  </main>
</body></html>`;

let browser: Browser;
let css: string;
beforeAll(async () => {
  [browser, css] = await Promise.all([chromium.launch(), buildCss()]);
});
afterAll(() => browser?.close());

describe.each(["light", "dark"])("shadcn core in Chromium (%s)", (theme) => {
  it("has no axe violations, color-contrast included", async () => {
    const tab = await browser.newPage();
    await tab.setContent(page(theme, css));
    await tab.addScriptTag({ content: axe.source });
    const violations = await tab.evaluate(async () => {
      // biome-ignore lint/suspicious/noExplicitAny: axe is injected globally
      const r = await (window as any).axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      });
      return r.violations.map(
        (v: { id: string; nodes: { target: string[] }[] }) =>
          `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      );
    });
    await tab.close();
    expect(violations).toEqual([]);
  });

  it("every focus outline is >= 3:1 against what it sits on", async () => {
    const tab = await browser.newPage();
    await tab.setContent(page(theme, css));
    const results: string[] = [];
    let focused = 0;
    for (let i = 0; i < 80; i++) {
      await tab.keyboard.press("Tab");
      const r = await tab.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const parse = (c: string) => c.match(/[\d.]+/g)?.map(Number) ?? [];
        const lum = (c: number[]) => {
          const [r, g, b] = c.slice(0, 3).map((v) => {
            const s = v / 255;
            return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        // The outline sits 2px outside the element, on its parent's fill.
        let host = el.parentElement;
        let bg = "rgb(255, 255, 255)";
        while (host) {
          const c = getComputedStyle(host).backgroundColor;
          if ((parse(c)[3] ?? 1) > 0) {
            bg = c;
            break;
          }
          host = host.parentElement;
        }
        const s = getComputedStyle(el);
        const [hi, lo] = [lum(parse(s.outlineColor)), lum(parse(bg))].sort(
          (a, b) => b - a,
        );
        return {
          id: `${el.tagName}.${el.textContent?.trim() || el.getAttribute("aria-label") || ""}`,
          style: s.outlineStyle,
          width: Number.parseFloat(s.outlineWidth),
          ratio: (hi + 0.05) / (lo + 0.05),
        };
      });
      if (!r) break;
      focused++;
      if (r.style !== "solid" || r.width < 2 || r.ratio < 3)
        results.push(`${r.id}: ${r.style} ${r.width}px ${r.ratio.toFixed(2)}`);
    }
    await tab.close();
    // Two copies (bg, surface): 6 buttons, 2 inputs, 2 badge links, trigger.
    expect(focused).toBeGreaterThanOrEqual(22);
    expect(results).toEqual([]);
  });
});
