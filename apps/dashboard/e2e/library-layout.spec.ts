// Library and search on @oa/ui/shadcn: page h1 20/600, the grid and list
// spacing, the tab strip, nothing wider than the viewport, and the card's
// keyboard ring and reduced-motion behaviour. Each run attaches a
// screenshot for review.
import { expect, type Page, test } from "@playwright/test";

const PAGES = {
  grid: "/?view=grid",
  list: "/?view=list",
  search: "/search?q=notes",
} as const;

const measure = (page: Page) =>
  page.evaluate(() => {
    const h1 = document.querySelector("#oa-main h1");
    const c = h1 ? getComputedStyle(h1) : null;
    const boxes = (sel: string) =>
      [...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect());
    const cards = boxes("#oa-main .lib-card");
    const rows = boxes("#oa-main .lib-row");
    const firstRowTop = cards[0]?.top ?? 0;
    const sameRow = cards.filter((r) => Math.abs(r.top - firstRowTop) < 1);
    const nextRow = cards.find((r) => r.top > firstRowTop + 1);
    return {
      h1: c ? [c.fontSize, c.fontWeight] : [],
      sideScroll:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      colGap:
        sameRow.length > 1
          ? Math.round((sameRow[1]?.left ?? 0) - (sameRow[0]?.right ?? 0))
          : null,
      rowGap:
        nextRow && cards[0] ? Math.round(nextRow.top - cards[0].bottom) : null,
      listGap:
        rows.length > 1
          ? Math.round((rows[1]?.top ?? 0) - (rows[0]?.bottom ?? 0))
          : null,
      cardPad: (() => {
        const card = document.querySelector("#oa-main .lib-card");
        return card ? getComputedStyle(card).paddingLeft : null;
      })(),
    };
  });

for (const [name, path] of Object.entries(PAGES))
  for (const width of [1280, 390])
    for (const theme of ["light", "dark"])
      test(`${name} geometry at ${width}px ${theme}`, async ({
        page,
      }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        await page.evaluate(
          (t) => document.documentElement.setAttribute("data-theme", t),
          theme,
        );
        await expect(
          page.locator(name === "grid" ? ".lib-card" : ".lib-row").first(),
        ).toBeVisible();
        const m = await measure(page);
        expect(m.h1).toEqual(["20px", "600"]);
        expect(m.sideScroll).toBe(0);
        if (name === "grid") {
          expect(m.cardPad).toBe("12px");
          expect(m.rowGap).toBe(16);
          if (width > 600) expect(m.colGap).toBe(16);
        } else if (m.listGap !== null) expect(m.listGap).toBe(8);
        await info.attach(`${name}-${width}-${theme}`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      });

test("library tabs keep a visible underline on the strip's edge", async ({
  page,
}) => {
  await page.goto("/");
  const tab = page.getByRole("tab", { name: "All" });
  await expect(tab).toHaveAttribute("data-state", "active");
  const u = await tab.evaluate((t) => {
    const a = getComputedStyle(t, "::after");
    const list = t.closest("[role=tablist]")?.getBoundingClientRect();
    return {
      opacity: a.opacity,
      height: a.height,
      bottom: a.bottom,
      inside: (list?.bottom ?? 0) >= t.getBoundingClientRect().bottom - 0.5,
    };
  });
  expect(u).toEqual({
    opacity: "1",
    height: "2px",
    bottom: "0px",
    inside: true,
  });
});

test("under reduced motion a card keeps the hover shadow but not the lift", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const card = page.locator(".lib-card").first();
  await expect(card).toBeVisible();
  const style = () =>
    card.evaluate((c) => {
      const s = getComputedStyle(c);
      return {
        transition: s.transitionProperty,
        transform: s.transform,
        shadow: s.boxShadow,
      };
    });
  const rest = await style();
  expect(rest.transition).toBe("none");
  await card.hover();
  const hover = await style();
  expect(hover.transform).toBe("none");
  expect(hover.shadow).not.toBe(rest.shadow);
});

test("keyboard focus rings the whole card: solid 2px at offset 2", async ({
  page,
}) => {
  await page.goto("/");
  const card = page.locator(".lib-card").first();
  const title = card.locator("a.lib-title");
  await expect(title).toBeVisible();
  await title.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(title).toBeFocused();
  const ring = await card.evaluate((c) => {
    const s = getComputedStyle(c);
    return [s.outlineStyle, s.outlineWidth, s.outlineOffset];
  });
  expect(ring).toEqual(["solid", "2px", "2px"]);
});
