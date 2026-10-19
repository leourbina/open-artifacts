// The shadcn sidebar in Chromium, both themes: axe, focus outlines, the
// active item's indicator, off-canvas collapse, and the mobile sheet.
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Focus, launch, oa, openStory, settled } from "./harness";

const STORY = "shadcn-sidebar--shadcn-sidebar";
const READY = '[data-slot="sidebar-wrapper"]';

let browser: Browser;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ browser, close } = await launch());
});
afterAll(() => close?.(), 15_000);

const tabWalk = async (page: Page, max = 40) => {
  const seen: NonNullable<Focus>[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const r = (await oa(page, "focus")) as Focus;
    if (!r) break;
    seen.push(r);
  }
  return seen;
};

describe.each(["light", "dark"])("shadcn sidebar in Chromium (%s)", (theme) => {
  it("has no axe violations", async () => {
    const page = await openStory(browser, STORY, theme, READY);
    expect(await oa(page, "axeRun")).toEqual([]);
    await page.close();
  });

  it("every focus outline is a solid 2px ring at >= 3:1", async () => {
    const page = await openStory(browser, STORY, theme, READY);
    const seen = await tabWalk(page);
    await page.close();
    // Brand, 4 nav links, 3 collections, trigger, search, upload.
    expect(seen.length).toBeGreaterThanOrEqual(10);
    expect(
      seen.filter((r) => !r.ok).map((r) => `${r.id}: ${r.detail}`),
    ).toEqual([]);
  });

  it("the active item's ring is >= 3:1 against its fill and the chrome", async () => {
    const page = await openStory(browser, STORY, theme, READY);
    const ratios = await page.evaluate(() => {
      const el = document.querySelector(
        '[data-sidebar="menu-button"][data-active="true"]',
      );
      const chrome = document.querySelector('[data-sidebar="sidebar"]');
      if (!el || !chrome) return [0, 0];
      const parse = (c: string) => c.match(/[\d.]+/g)?.map(Number) ?? [];
      const lum = (c: number[]) => {
        const [r, g, b] = c.slice(0, 3).map((v) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const contrast = (a: string, b: string) => {
        const [hi, lo] = [lum(parse(a)), lum(parse(b))].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
      };
      const s = getComputedStyle(el);
      const ring = s.boxShadow
        .split(/,(?![^(]*\))/)
        .filter((x) => x.includes("inset"))
        .map((x) => x.match(/rgba?\([^)]*\)/)?.[0] ?? "")
        .find((c) => c && (parse(c)[3] ?? 1) > 0);
      if (!ring) return [0, 0];
      return [
        contrast(ring, s.backgroundColor),
        contrast(ring, getComputedStyle(chrome).backgroundColor),
      ];
    });
    await page.close();
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(3);
  });

  it("keeps its px sizes under a 13px root font-size", async () => {
    const page = await openStory(browser, STORY, theme, READY);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "13px";
    });
    const sizes = await page.evaluate(() => {
      const h = (sel: string) =>
        document.querySelector(sel)?.getBoundingClientRect().height;
      return {
        width: document
          .querySelector('[data-slot="sidebar-container"]')
          ?.getBoundingClientRect().width,
        item: h('[data-sidebar="menu-button"][data-active="true"]'),
        brand: h('[data-sidebar="menu-button"][data-size="lg"]'),
        font: getComputedStyle(
          document.querySelector(
            '[data-sidebar="menu-button"][data-active="true"]',
          ) as Element,
        ).fontSize,
      };
    });
    await page.close();
    expect(sizes).toEqual({ width: 256, item: 32, brand: 48, font: "14px" });
  });

  it("collapses off-canvas: Cmd/Ctrl+B and the trigger, out of the tab order", async () => {
    const page = await openStory(browser, STORY, theme, READY);
    const state = () =>
      page.evaluate(() =>
        document
          .querySelector('[data-slot="sidebar"][data-state]')
          ?.getAttribute("data-state"),
      );
    expect(await state()).toBe("expanded");
    await page.keyboard.press("ControlOrMeta+b");
    expect(await state()).toBe("collapsed");
    const ids = (await tabWalk(page)).map((r) => r.id);
    expect(ids.some((id) => /Library|Open Artifacts/.test(id))).toBe(false);
    await page.locator('[data-sidebar="trigger"]').click();
    expect(await state()).toBe("expanded");
    await page.close();
  });

  it("is a sheet on mobile: opens, passes axe, closes on Escape", async () => {
    const page = await openStory(browser, STORY, theme, READY, {
      width: 390,
      height: 760,
    });
    const trigger = page.locator('[data-sidebar="trigger"]');
    await trigger.focus();
    await page.keyboard.press("Enter");
    const sel = '[data-mobile="true"][role="dialog"]';
    const sheet = page.locator(sel);
    await settled(page, sel);
    const violations = await oa(page, "axeRun", true);
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    const back = await trigger.evaluate((el) => el === document.activeElement);
    await page.close();
    expect(violations).toEqual([]);
    expect(back).toBe(true);
  });
});
