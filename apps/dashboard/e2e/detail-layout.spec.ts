// Artifact detail chrome on the shadcn primitives: the title bar, the side
// panel frame, the version history and the diff page. Checks the h1 (20/600),
// the 20px (16px at <= 600px) gutters, no side scroll and that nothing leaves
// the viewport, at 1280 and 390, light and dark. Each run attaches a shot.
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs";
const VIEWS = [
  ["viewer", `/a/${ID}`],
  ["panel", `/a/${ID}?panel=open&tab=versions`],
  ["diff", `/a/${ID}/diff/1/2`],
] as const;

const noSideScroll = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );

for (const [name, url] of VIEWS)
  for (const width of [1280, 390])
    for (const theme of ["light", "dark"])
      test(`detail/${name} geometry at ${width}px ${theme}`, async ({
        page,
      }, info) => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(url);
        await page.evaluate(
          (t) => document.documentElement.setAttribute("data-theme", t),
          theme,
        );
        const h1 = page.getByRole("heading", { level: 1 });
        await expect(h1).toBeVisible();
        const pad = width <= 600 ? 16 : 20;

        const font = await h1.evaluate((el) => {
          const s = getComputedStyle(el);
          return [s.fontSize, s.fontWeight];
        });
        expect(font).toEqual(["20px", "600"]);
        expect(await noSideScroll(page)).toBe(true);

        const box = await h1.boundingBox();
        if (name === "diff")
          expect(Math.round(box?.x ?? 0)).toBe(20 + (width <= 600 ? -4 : 0));
        else {
          // The title bar pads 20px (16px at <= 600px) on both sides.
          const bar = await page.locator(".oa-vt").evaluate((el) => {
            const s = getComputedStyle(el);
            return [s.paddingLeft, s.paddingRight];
          });
          expect(bar).toEqual([`${pad}px`, `${pad}px`]);
          // Every action stays inside the viewport.
          for (const b of await page.locator(".oa-vt button").all()) {
            const r = await b.boundingBox();
            expect(r?.x ?? 0).toBeGreaterThanOrEqual(0);
            expect((r?.x ?? 0) + (r?.width ?? 0)).toBeLessThanOrEqual(width);
          }
        }

        if (name === "panel") {
          const panel = page.getByRole("complementary", { name: "Side panel" });
          const pb = await panel.boundingBox();
          // 320px of content (353px with padding and border) beside the frame; the full width over it below 960px.
          expect(Math.round(pb?.width ?? 0)).toBe(width < 960 ? width : 353);
          await expect(
            page.getByRole("tab", { name: "Versions" }),
          ).toHaveAttribute("aria-selected", "true");
          for (const b of await panel.getByRole("button").all()) {
            const r = await b.boundingBox();
            expect((r?.x ?? 0) + (r?.width ?? 0)).toBeLessThanOrEqual(
              (pb?.x ?? 0) + (pb?.width ?? 0) + 0.5,
            );
          }
        }

        await info.attach(`detail-${name}-${width}-${theme}`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      });

test("detail: no upload-version control and the old chrome classes are gone", async ({
  page,
}) => {
  await page.goto(`/a/${ID}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  for (const c of [".oa-vt-title", ".oa-vpanel", ".oa-top", ".oa-btn"])
    await expect(page.locator(c)).toHaveCount(0);
});
