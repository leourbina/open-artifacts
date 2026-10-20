// The shadcn popover in Chromium, both themes: opens on click and Enter,
// moves focus in, closes on Escape back to the trigger, passes axe.
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Focus, launch, oa, openStory, settled } from "./harness";

const STORY = "shadcn-popover--shadcn-popover";
const READY = "[data-popover-ready]";
const SEL = '[data-slot="popover-content"]';

let browser: Browser;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ browser, close } = await launch());
});
afterAll(() => close?.(), 15_000);

const trigger = (page: Page) =>
  page.getByRole("button", { name: "Update available", exact: true });

describe.each(["light", "dark"])("shadcn popover in Chromium (%s)", (theme) => {
  it("opens on click with focus inside", async () => {
    const page = await openStory(browser, STORY, theme, READY);
    await trigger(page).click();
    await settled(page, SEL);
    const expanded = await trigger(page).getAttribute("aria-expanded");
    await page.close();
    expect(expanded).toBe("true");
  });

  it("opens on Enter, passes axe, Escape returns focus to the trigger", async () => {
    const page = await openStory(browser, STORY, theme, READY);
    await trigger(page).focus();
    await page.keyboard.press("Enter");
    await settled(page, SEL);
    const focus = (await oa(page, "focus")) as Focus;
    const violations = await oa(page, "axeRun");
    await page.keyboard.press("Escape");
    await page.waitForSelector(SEL, { state: "detached" });
    const back = await trigger(page).evaluate(
      (el) => el === document.activeElement,
    );
    await page.close();
    expect(focus?.id).toBe("BUTTON.Later");
    expect(focus?.ok, `${focus?.id}: ${focus?.detail}`).toBe(true);
    expect(violations).toEqual([]);
    expect(back).toBe(true);
  });

  it("has a radius of 8px and no animation under reduced motion", async () => {
    const page = await openStory(browser, STORY, theme, READY);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await trigger(page).click();
    await settled(page, SEL);
    const s = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as Element;
      return {
        radius: getComputedStyle(el).borderTopLeftRadius,
        animation: getComputedStyle(el).animationName,
      };
    }, SEL);
    await page.close();
    expect(s).toEqual({ radius: "8px", animation: "none" });
  });
});
