// Hosted P4 D10: the "View only" chip for guests on live-data artifacts, and
// not for employee viewers, at 1280 and 390, light and dark.
import { expect, test } from "@playwright/test";

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 } });

      for (const [who, mock, chipShown, what] of [
        ["guest", "guest-live", true, "a live-data artifact"],
        ["contractor", "contractor-live", true, "a live-data artifact"],
        ["guest-static", "guest-static", false, "a static artifact"],
        ["employee", "viewer-live", false, "a live-data artifact"],
      ] as const)
        test(`${who} viewer on ${what}`, async ({ page }, info) => {
          await page.goto(`/?hosted=1&mock=${mock}`);
          await page.getByRole("link", { name: "Q4 report" }).first().click();
          await page.waitForURL(/\/a\//);
          await page.getByRole("heading", { name: "Q4 report" }).waitFor();
          const chip = page.getByText("View only", { exact: true });
          if (chipShown) await expect(chip).toBeVisible();
          else await expect(chip).toHaveCount(0);
          await expect(page.getByRole("button", { name: "Share" })).toHaveCount(
            0,
          );
          await page.screenshot({
            path: info.outputPath(`view-only-${who}-${scheme}-${width}.png`),
          });
          if (!chipShown) return;
          await chip.focus();
          await expect(
            page.getByRole("tooltip", {
              name: "You can view this, but you can't change its data.",
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
