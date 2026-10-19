// Sidebar: the brand row lines up with the header, every nav row shares one
// height and icon column, and the active row is a fill without a box.
import { expect, test } from "@playwright/test";

test("sidebar brand and nav rows line up with the header", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: "Library" })).toBeVisible();
  const m = await nav.evaluate((nav) => {
    const box = (el?: Element | null) => el?.getBoundingClientRect();
    const brand = nav.querySelector(".oa-brand");
    const mark = [...(brand?.querySelectorAll("img") ?? [])].find(
      (i) => i.getBoundingClientRect().width,
    );
    const header = document.querySelector("header");
    const aside = nav.closest("aside");
    const links = [...nav.querySelectorAll("a")];
    const active = nav.querySelector("a[aria-current=page]");
    const a = active ? getComputedStyle(active) : null;
    const b = box(brand);
    const h = box(header);
    return {
      markTop: (box(mark)?.top ?? 0) - (box(aside)?.top ?? 0),
      brandBottom: b?.bottom,
      headerBottom: h?.bottom,
      brandMid: b ? (b.top + b.bottom) / 2 : 0,
      headerMid: h ? (h.top + h.bottom - 1) / 2 : 0,
      heights: [...new Set(links.map((l) => box(l)?.height))],
      iconX: [...new Set(links.map((l) => box(l.querySelector("svg"))?.left))],
      labelX: [
        ...new Set(links.map((l) => box(l.querySelector("span"))?.left)),
      ],
      activeBorder: a
        ? parseFloat(a.borderTopWidth) + parseFloat(a.borderLeftWidth)
        : -1,
      activeShadow: a?.boxShadow,
      activeFill: a?.backgroundColor,
    };
  });
  expect(m.markTop).toBeGreaterThanOrEqual(8);
  expect(m.brandBottom).toBe(m.headerBottom);
  expect(Math.abs(m.brandMid - m.headerMid)).toBeLessThanOrEqual(1);
  expect(m.heights).toHaveLength(1);
  expect(m.iconX).toHaveLength(1);
  expect(m.labelX).toHaveLength(1);
  expect(m.activeBorder).toBe(0);
  expect(m.activeShadow).toBe("none");
  expect(m.activeFill).not.toBe("rgba(0, 0, 0, 0)");
});

test("the drawer at 390px shows the brand and navigates", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.locator(".oa-brand img:visible")).toHaveCount(1);
  await drawer.getByRole("link", { name: "Team" }).click();
  await expect(page).toHaveURL(/\/team$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
