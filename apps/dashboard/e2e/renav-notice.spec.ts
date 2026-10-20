// The renavigation notice's layout: inside the viewer at 1280 and 390, no
// sideways scroll, no serious axe violations in either theme.
import { createRequire } from "node:module";
import { fixtures } from "@oa/shared/mocks";
import { expect, type Page, test } from "@playwright/test";

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});

const POLL = (
  fixtures.artifacts.find((a) => a.title === "Team poll") as { id: string }
).id;

const renavigate = async (page: Page) => {
  await page.goto(`/a/${POLL}`);
  await page.waitForLoadState("networkidle");
  const frame = await (
    await page.locator("iframe.oa-vframe").elementHandle()
  )?.contentFrame();
  // The frame reloads itself: a load the shell didn't start.
  await frame?.evaluate(() => location.reload()).catch(() => {});
  return page.getByRole("status").filter({ hasText: /^Live data is off/ });
};

for (const theme of ["light", "dark"])
  for (const width of [1280, 390])
    test(`renav notice fits and passes axe at ${width} ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
      const notice = await renavigate(page);
      await expect(notice).toBeVisible();
      await page.evaluate(
        (t) => document.documentElement.setAttribute("data-theme", t),
        theme,
      );
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      ).toBe(0);
      await page.addScriptTag({ path: AXE });
      const v = await page.evaluate(async () => {
        // @ts-expect-error injected
        const res = await axe.run(".oa-vrenav", {
          resultTypes: ["violations"],
        });
        return res.violations
          .filter(
            (x: { impact: string }) =>
              x.impact === "serious" || x.impact === "critical",
          )
          .map((x: { id: string }) => x.id);
      });
      expect(v).toEqual([]);
      await notice.getByRole("button", { name: "Dismiss" }).click();
      await expect(notice).toBeHidden();
    });
