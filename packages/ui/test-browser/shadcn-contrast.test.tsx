// Real-browser a11y for the shadcn components: the "shadcn / a11y fixture"
// Ladle story (every component on bg and on surface) in Chromium, both
// themes: axe incl. color-contrast, outlined borders, every focus outline
// (Tab walk), each overlay while open, state indicators, focus traps, toasts.
// jsdom can't do any of this. Run: pnpm --filter @oa/ui test:browser
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Focus, oa, openStory } from "./harness";

const STORY = "shadcn-a11y--shadcn-a11y-fixture";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(() => browser?.close());

const open = (theme: string) =>
  openStory(browser, STORY, theme, "[data-a11y-ready]");

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

  it("state indicators are >= 3:1 against their own fill", async () => {
    const page = await open(theme);
    const found = (await oa(page, "indicators")) as {
      label: string;
      count: number;
      worst: number;
    }[];
    await page.close();
    for (const { label, count, worst } of found) {
      expect(count, label).toBeGreaterThan(0);
      expect(worst, label).toBeGreaterThanOrEqual(3);
    }
  });

  it("toggles expose their state to AT", async () => {
    const page = await open(theme);
    const on = page.locator('[data-slot="toggle-group-item"][data-state="on"]');
    expect(await on.count()).toBeGreaterThan(0);
    // Single-select groups are radio groups: aria-checked mirrors data-state.
    for (const el of await on.all())
      expect(await el.getAttribute("aria-checked")).toBe("true");
    await page.close();
  });

  it.each([
    ["Open dialog", '[role="dialog"]'],
    ["Delete artifact", '[role="alertdialog"]'],
  ])("%s traps focus and returns it to the trigger", async (label, sel) => {
    const page = await open(theme);
    const trigger = page
      .getByRole("button", { name: label, exact: true })
      .first();
    await trigger.focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector(sel);
    const escaped: string[] = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(
        (s) => !!document.activeElement?.closest(s),
        sel,
      );
      if (!inside) escaped.push(`Tab ${i + 1}`);
    }
    await page.keyboard.press("Escape");
    await page.waitForSelector(sel, { state: "detached" });
    const back = await trigger.evaluate((el) => el === document.activeElement);
    await page.close();
    expect(escaped).toEqual([]);
    expect(back).toBe(true);
  });

  it("tooltip has no axe violations when shown", async () => {
    const page = await open(theme);
    await page
      .getByRole("button", { name: "Hover", exact: true })
      .first()
      .focus();
    await page.waitForSelector('[role="tooltip"]', { state: "attached" });
    expect(await oa(page, "axeRun")).toEqual([]);
    await page.close();
  });

  it.each([
    ["Show toast", "default"],
    ["Show success toast", "success"],
    ["Show error toast", "error"],
    ["Show warning toast", "warning"],
  ])("%s has no axe violations", async (label, type) => {
    const page = await open(theme);
    await page
      .getByRole("button", { name: label, exact: true })
      .first()
      .click();
    await page.waitForSelector(
      type === "default"
        ? "[data-sonner-toast]"
        : `[data-sonner-toast][data-type="${type}"]`,
    );
    expect(await oa(page, "axeRun")).toEqual([]);
    await page.close();
  });

  it("toasts follow a data-theme flip", async () => {
    const page = await open(theme);
    await page
      .getByRole("button", { name: "Show toast", exact: true })
      .first()
      .click();
    await page.waitForSelector("[data-sonner-toaster]", { state: "attached" });
    const themeOf = () =>
      page.evaluate(() =>
        document
          .querySelector("[data-sonner-toaster]")
          ?.getAttribute("data-sonner-theme"),
      );
    expect(await themeOf()).toBe(theme);
    const other = theme === "light" ? "dark" : "light";
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, other);
    await page.waitForFunction(
      (t) =>
        document
          .querySelector("[data-sonner-toaster]")
          ?.getAttribute("data-sonner-theme") === t,
      other,
    );
    expect(await themeOf()).toBe(other);
    await page.close();
  });
});
