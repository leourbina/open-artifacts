// Hosted P4 D10: the "View only" chip for guests on live-data artifacts, and
// not for employee viewers, at 1280 and 390, light and dark.
import { expect, test } from "@playwright/test";

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 } });

      for (const [who, dataWrite] of [
        ["guest", false],
        ["employee", true],
      ] as const)
        test(`${who} viewer on a live-data artifact`, async ({
          page,
        }, info) => {
          await page.goto(
            `/?hosted=1&mock=${who === "guest" ? "guest" : "viewer"}-live`,
          );
          await page.getByRole("link", { name: "Q4 report" }).first().click();
          await page.waitForURL(/\/a\//);
          await page.getByRole("heading", { name: "Q4 report" }).waitFor();
          const chip = page.getByText("View only", { exact: true });
          if (dataWrite) await expect(chip).toHaveCount(0);
          else await expect(chip).toBeVisible();
          await expect(page.getByRole("button", { name: "Share" })).toHaveCount(
            0,
          );
          await page.screenshot({
            path: info.outputPath(`view-only-${who}-${scheme}-${width}.png`),
          });
          if (dataWrite) return;
          await chip.focus();
          await expect(
            page.getByRole("tooltip", {
              name: "You can view this. Ask a space manager to make you an editor.",
            }),
          ).toBeVisible();
          await page.waitForFunction(() =>
            document.getAnimations().every((x) => x.playState !== "running"),
          );
          await page.screenshot({
            path: info.outputPath(`view-only-tooltip-${scheme}-${width}.png`),
          });
        });
    });
