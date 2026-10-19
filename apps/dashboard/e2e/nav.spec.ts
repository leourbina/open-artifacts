// Sidebar A ("Flush", Design spec): sizes, the brand row lined up with the
// header, row metrics, the active/focus treatment, and the phone sheet.
import { expect, test } from "@playwright/test";

test("sidebar A metrics at 1280px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: "Library" })).toBeVisible();
  const m = await page.evaluate(() => {
    const box = (el?: Element | null) => el?.getBoundingClientRect();
    const css = (el: Element) => getComputedStyle(el);
    const resolve = (prop: string, value: string) => {
      const probe = document.createElement("div");
      probe.style.setProperty(prop, value);
      document.body.append(probe);
      const out = getComputedStyle(probe).getPropertyValue(prop);
      probe.remove();
      return out;
    };
    const side = document.querySelector("[data-slot=sidebar-container]");
    const head = document.querySelector("[data-slot=sidebar-header]");
    const brand = head?.querySelector("a");
    const mark = brand?.querySelector("svg");
    const word = brand?.querySelector("span");
    const header = document.querySelector("header");
    const links = [
      ...document.querySelectorAll<HTMLElement>(
        "nav[aria-label=Primary] a[data-slot=sidebar-menu-button]",
      ),
    ];
    const rows = links.map((a) => box(a) as DOMRect);
    const active = links.find((a) => a.dataset.active === "true");
    return {
      html: css(document.documentElement).fontSize,
      body: css(document.body).fontSize,
      width: box(side)?.width,
      brandHeight: box(head)?.height,
      brandBottom: box(head)?.bottom,
      headerBottom: box(header)?.bottom,
      mark: box(mark)?.width,
      word: word ? [css(word).fontSize, css(word).fontWeight] : [],
      heights: [...new Set(rows.map((r) => r.height))],
      gaps: [
        ...new Set(rows.slice(1).map((r, i) => r.top - (rows[i]?.bottom ?? 0))),
      ],
      iconX: [...new Set(links.map((a) => box(a.querySelector("svg"))?.left))],
      icon: [...new Set(links.map((a) => box(a.querySelector("svg"))?.width))],
      iconGap: [
        ...new Set(
          links.map(
            (a) =>
              (box(a.querySelector("span"))?.left ?? 0) -
              (box(a.querySelector("svg"))?.right ?? 0),
          ),
        ),
      ],
      padding: [...new Set(links.map((a) => css(a).paddingLeft))],
      radius: [...new Set(links.map((a) => css(a).borderTopLeftRadius))],
      activeBg: active ? css(active).backgroundColor : "",
      card: resolve("background-color", "var(--oa-surface)"),
      activeRing: active ? css(active).boxShadow : "",
      ringColor: resolve("color", "var(--oa-border-strong)"),
      activeWeight: active ? css(active).fontWeight : "",
    };
  });
  expect(m.html).toBe("16px");
  expect(m.body).toBe("13px");
  expect(m.width).toBe(256);
  expect(m.brandHeight).toBe(49);
  expect(m.brandBottom).toBe(m.headerBottom);
  expect(m.mark).toBe(24);
  expect(m.word).toEqual(["16px", "600"]);
  expect(m.heights).toEqual([32]);
  expect(m.gaps).toEqual([4]);
  expect(m.iconX).toHaveLength(1);
  expect(m.icon).toEqual([16]);
  expect(m.iconGap).toEqual([8]);
  expect(m.padding).toEqual(["8px"]);
  expect(m.radius).toEqual(["6px"]);
  expect(m.activeBg).toBe(m.card);
  expect(m.activeRing).toContain(`${m.ringColor} 0px 0px 0px 1px inset`);
  expect(m.activeWeight).toBe("500");

  // Focus: a 2px solid inset outline.
  await page.keyboard.press("Tab"); // skip link
  await page.keyboard.press("Tab"); // brand
  await page.keyboard.press("Tab"); // Library
  const ring = await nav
    .getByRole("link", { name: "Library" })
    .evaluate((a) => {
      const c = getComputedStyle(a);
      return [
        a.matches(":focus-visible"),
        c.outlineStyle,
        c.outlineWidth,
        c.outlineOffset,
      ];
    });
  expect(ring).toEqual([true, "solid", "2px", "-2px"]);
});

test("phone: a 288px sheet that navigates, closes and returns focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Toggle navigation" });
  await trigger.click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("link", { name: "Team" })).toBeVisible();
  expect((await sheet.boundingBox())?.width).toBe(288);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole("dialog").getByRole("link", { name: "Team" }).click();
  await expect(page).toHaveURL(/\/team$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

// One shell gutter: 24px, 16px at <= 600px. Library has no side padding of
// its own; Settings centers its 880px column inside the gutter.
for (const [width, gutter] of [
  [1280, 24],
  [800, 24],
  [600, 16],
  [390, 16],
] as const)
  test(`page gutter is ${gutter}px at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const gap = (sel: string) =>
      page.evaluate((sel) => {
        const main = document
          .getElementById("oa-main")
          ?.getBoundingClientRect();
        const el = document.querySelector(sel)?.getBoundingClientRect();
        return {
          left: (el?.left ?? 0) - (main?.left ?? 0),
          right: (main?.right ?? 0) - (el?.right ?? 0),
        };
      }, sel);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await gap(".lib")).toEqual({ left: gutter, right: gutter });
    await page.goto("/settings/agents");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const s = await gap(".oa-settings");
    expect(s.left).toBeGreaterThanOrEqual(gutter);
    expect(Math.abs(s.left - s.right)).toBeLessThanOrEqual(1);
    if (width < 880 + 2 * gutter + 256) expect(s.left).toBe(gutter);
  });
