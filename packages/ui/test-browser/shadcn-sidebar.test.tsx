// The shadcn sidebar in Chromium, both themes: axe, focus outlines, the
// active item's indicator, off-canvas collapse, and the mobile sheet.
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Focus, oa, openStory } from "./harness";

const STORY = "shadcn-sidebar--shadcn-sidebar";
const READY = '[data-slot="sidebar-wrapper"]';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(() => browser?.close());

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

  it("the active item's indicator is >= 3:1 against its own fill", async () => {
    const page = await openStory(browser, STORY, theme, READY);
    const ratio = await page.evaluate(() => {
      const el = document.querySelector(
        '[data-sidebar="menu-button"][data-active="true"]',
      );
      if (!el) return 0;
      const parse = (c: string) => c.match(/[\d.]+/g)?.map(Number) ?? [];
      const lum = (c: number[]) => {
        const [r, g, b] = c.slice(0, 3).map((v) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const s = getComputedStyle(el);
      const ring = s.boxShadow
        .split(/,(?![^(]*\))/)
        .filter((x) => x.includes("inset"))
        .map((x) => x.match(/rgba?\([^)]*\)/)?.[0] ?? "")
        .find((c) => c && (parse(c)[3] ?? 1) > 0);
      if (!ring) return 0;
      const [hi, lo] = [lum(parse(ring)), lum(parse(s.backgroundColor))].sort(
        (a, b) => b - a,
      );
      return (hi + 0.05) / (lo + 0.05);
    });
    await page.close();
    expect(ratio).toBeGreaterThanOrEqual(3);
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
    const sheet = page.locator('[data-mobile="true"][role="dialog"]');
    await sheet.waitFor();
    const violations = await oa(page, "axeRun", true);
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    const back = await trigger.evaluate((el) => el === document.activeElement);
    await page.close();
    expect(violations).toEqual([]);
    expect(back).toBe(true);
  });
});
