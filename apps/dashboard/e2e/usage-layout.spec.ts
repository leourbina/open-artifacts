// Usage on the shadcn primitives (Design's card rules): h1 20/600, the 880px
// measure, cards padded 20px (16px at <= 600px) with 12px from header to body,
// 16px between cards in both directions, nothing past a card's edge or the
// viewport. Each run attaches a screenshot for review.
import { expect, test } from "@playwright/test";

for (const width of [1280, 390])
  for (const theme of ["light", "dark"])
    test(`settings/usage geometry at ${width}px ${theme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/settings/usage?mock=cpu");
      await page.evaluate(
        (t) => document.documentElement.setAttribute("data-theme", t),
        theme,
      );
      await expect(page.getByRole("region", { name: "CPU" })).toBeVisible();

      const pad = width <= 600 ? 16 : 20;
      const g = await page.evaluate(() => {
        const px = (v: string) => parseFloat(v);
        const h1 = getComputedStyle(
          document.querySelector("#oa-main h1") as HTMLElement,
        );
        const column = (
          document.querySelector("#oa-main h1") as HTMLElement
        ).parentElement?.parentElement?.getBoundingClientRect();
        const cards = [
          ...document.querySelectorAll<HTMLElement>(
            "#oa-main [data-slot=card]",
          ),
        ];
        const per = cards.map((card) => {
          const c = getComputedStyle(card);
          const r = card.getBoundingClientRect();
          const parts = [
            ...card.querySelectorAll<HTMLElement>(
              ":scope > [data-slot^=card-]",
            ),
          ];
          const header = card.querySelector("[data-slot=card-header]");
          const body = card.querySelector("[data-slot=card-content]");
          const inner = r.right - px(c.borderRightWidth);
          const overflow = [...card.querySelectorAll("*")].filter((el) => {
            for (let p = el.parentElement; p && p !== card; p = p.parentElement)
              if (getComputedStyle(p).overflowX !== "visible") return false;
            const b = el.getBoundingClientRect();
            return b.width > 0 && b.right > inner + 0.5;
          }).length;
          return {
            padY: [px(c.paddingTop), px(c.paddingBottom)],
            padX: [
              ...new Set(
                parts.flatMap((p) => [
                  px(getComputedStyle(p).paddingLeft),
                  px(getComputedStyle(p).paddingRight),
                ]),
              ),
            ],
            headerToBody:
              header && body
                ? body.getBoundingClientRect().top -
                  header.getBoundingClientRect().bottom
                : null,
            overflow,
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
          };
        });
        // Cards in rows: the gap between rows, and between cards in a row.
        const rows = [...new Set(per.map((c) => Math.round(c.top)))].sort(
          (a, b) => a - b,
        );
        const rowGaps = rows.slice(1).map((top, i) => {
          const above = per.filter((c) => Math.round(c.top) === rows[i]);
          return Math.round(top - Math.max(...above.map((c) => c.bottom)));
        });
        const colGaps = rows.flatMap((top) => {
          const row = per
            .filter((c) => Math.round(c.top) === top)
            .sort((a, b) => a.left - b.left);
          return row
            .slice(1)
            .map((c, i) => Math.round(c.left - (row[i]?.right ?? 0)));
        });
        return {
          h1: [px(h1.fontSize), h1.fontWeight],
          columnWidth: column?.width ?? 0,
          per,
          rowGaps,
          colGaps,
          sideScroll:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        };
      });

      expect(g.h1).toEqual([20, "600"]);
      expect(g.sideScroll).toBe(0);
      expect(g.columnWidth).toBeLessThanOrEqual(880);
      expect(g.per.length).toBe(5); // four meters and the CPU card
      for (const c of g.per) {
        expect(c.padY).toEqual([pad, pad]);
        expect(c.padX).toEqual([pad]);
        if (c.headerToBody !== null) expect(c.headerToBody).toBe(12);
        expect(c.overflow).toBe(0);
      }
      expect(g.rowGaps.length).toBe(width <= 600 ? 4 : 2);
      for (const gap of g.rowGaps) expect(gap).toBe(16);
      expect(g.colGaps).toEqual(width <= 600 ? [] : [16, 16]);

      await info.attach(`usage-${width}-${theme}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    });
