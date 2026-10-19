// Real-browser a11y for the shadcn components. Builds Ladle (Vite + Tailwind
// + the Studio tokens), opens the "shadcn / a11y fixture" story in Chromium
// under <html data-theme>, and checks: axe incl. color-contrast, outlined
// borders, every focus outline (Tab walk), and each overlay while open
// (axe plus the outline on its focused item). jsdom can't do any of this.
// Run: pnpm --filter @oa/ui test:browser
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";
import axe from "axe-core";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const pkg = resolve(import.meta.dirname, "..");
const out = "node_modules/.cache/oa-ladle-a11y";
const STORY = "shadcn-a11y--shadcn-a11y-fixture";

let server: Server;
let base: string;
let browser: Browser;

beforeAll(async () => {
  execFileSync("pnpm", ["exec", "ladle", "build", "-o", out], {
    cwd: pkg,
    stdio: "pipe",
  });
  const root = join(pkg, out);
  const types: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
  };
  server = createServer((req, res) => {
    const path = join(root, new URL(req.url ?? "/", "http://x").pathname);
    const file =
      existsSync(path) && statSync(path).isFile()
        ? path
        : join(root, "index.html");
    res.setHeader("content-type", types[extname(file)] ?? "text/plain");
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
});

type Focus = { id: string; ok: boolean; detail: string } | null;

async function open(theme: string): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(`${base}/?story=${STORY}&mode=preview`);
  await page.waitForSelector("[data-a11y-ready]");
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  // Measure settled styles: transition-all would animate outlines in.
  await page.addStyleTag({
    content: "*, *::before, *::after { transition: none !important; }",
  });
  await page.addScriptTag({ content: axe.source });
  await page.addScriptTag({ content: `(${pageHelpers})()` });
  return page;
}

// Runs in the page: WCAG ratio helpers on window.__oa.
function pageHelpers() {
  const parse = (c: string) => c.match(/[\d.]+/g)?.map(Number) ?? [];
  const lum = (c: number[]) => {
    const [r, g, b] = c.slice(0, 3).map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(parse(a)), lum(parse(b))].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const fill = (el: Element | null) => {
    for (let h = el; h; h = h.parentElement) {
      const c = getComputedStyle(h).backgroundColor;
      if ((parse(c)[3] ?? 1) > 0) return c;
    }
    return "rgb(255, 255, 255)";
  };
  const name = (el: Element) =>
    `${el.tagName}.${el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 24) || ""}`;
  // Inset outlines (negative offset) sit on the element's own fill.
  const focus = () => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const s = getComputedStyle(el);
    const inset = Number.parseFloat(s.outlineOffset) < 0;
    const r = ratio(s.outlineColor, fill(inset ? el : el.parentElement));
    const ok =
      s.outlineStyle === "solid" &&
      Number.parseFloat(s.outlineWidth) >= 2 &&
      r >= 3;
    return {
      id: name(el),
      ok,
      detail: `${s.outlineStyle} ${s.outlineWidth} ${r.toFixed(2)}`,
    };
  };
  // `overlay`: an open modal. Radix hides the page with aria-hidden while
  // trapping focus in the overlay, which axe's aria-hidden-focus flags.
  const axeRun = async (overlay = false) => {
    // biome-ignore lint/suspicious/noExplicitAny: axe is injected globally
    const res = await (window as any).axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      rules: {
        region: { enabled: false },
        "aria-hidden-focus": { enabled: !overlay },
      },
    });
    return res.violations.map(
      (v: { id: string; nodes: { target: string[] }[] }) =>
        `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    );
  };
  const borders = () =>
    [
      ...document.querySelectorAll(
        '[data-variant="outline"], [data-slot="input"], [data-slot="select-trigger"]',
      ),
    ]
      // Group wrappers carry data-variant too but draw no border.
      .filter(
        (el) => Number.parseFloat(getComputedStyle(el).borderTopWidth) > 0,
      )
      .map((el) => ({
        id: name(el),
        r: ratio(getComputedStyle(el).borderTopColor, fill(el.parentElement)),
      }))
      .filter((m) => m.r < 3)
      .map((m) => `${m.id} ${m.r.toFixed(2)}`);
  // biome-ignore lint/suspicious/noExplicitAny: test-only global
  (window as any).__oa = { focus, axeRun, borders };
}

const oa = (page: Page, fn: "focus" | "axeRun" | "borders", arg?: boolean) =>
  // biome-ignore lint/suspicious/noExplicitAny: test-only global
  page.evaluate(([f, a]) => (window as any).__oa[f as string](a), [fn, arg]);

describe.each(["light", "dark"])("shadcn in Chromium (%s)", (theme) => {
  it("has no axe violations, color-contrast included", async () => {
    const page = await open(theme);
    expect(await oa(page, "axeRun")).toEqual([]);
    await page.close();
  });

  it("outlined controls' computed borders are >= 3:1 on their page", async () => {
    const page = await open(theme);
    expect(await oa(page, "borders")).toEqual([]);
    await page.close();
  });

  it("every focus outline is a solid 2px ring at >= 3:1", async () => {
    const page = await open(theme);
    const bad: string[] = [];
    let focused = 0;
    for (let i = 0; i < 120; i++) {
      await page.keyboard.press("Tab");
      const r = (await oa(page, "focus")) as Focus;
      if (!r) break;
      focused++;
      if (!r.ok) bad.push(`${r.id}: ${r.detail}`);
    }
    await page.close();
    // Two copies (bg, surface) of ~20 focusable controls each.
    expect(focused).toBeGreaterThanOrEqual(36);
    expect(bad).toEqual([]);
  });

  // Each overlay opened from the keyboard: axe on the open state, then the
  // outline on the first item focused inside it.
  it.each([
    ["select", "combobox", "Role", "ArrowDown", '[role="listbox"]'],
    ["dropdown menu", "button", "Actions", "ArrowDown", '[role="menu"]'],
    ["dialog", "button", "Open dialog", "Tab", '[role="dialog"]'],
    [
      "alert dialog",
      "button",
      "Delete artifact",
      "Tab",
      '[role="alertdialog"]',
    ],
  ] as const)("%s, open", async (_, role, label, key, selector) => {
    const page = await open(theme);
    await page.getByRole(role, { name: label, exact: true }).first().focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector(selector);
    const violations = await oa(page, "axeRun", true);
    await page.keyboard.press(key);
    const focus = (await oa(page, "focus")) as Focus;
    await page.close();
    expect(violations).toEqual([]);
    expect(focus?.ok, `${focus?.id}: ${focus?.detail}`).toBe(true);
  });

  it("toast has no axe violations", async () => {
    const page = await open(theme);
    await page.getByRole("button", { name: "Show toast" }).first().click();
    await page.waitForSelector("[data-sonner-toast]");
    expect(await oa(page, "axeRun")).toEqual([]);
    await page.close();
  });
});
