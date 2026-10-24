// A non-admin space manager sees other managers' rows as text, at 1280 and
// 390, light and dark (the mock serves two other managers and Bob).
import { expect, type Page, test } from "@playwright/test";

const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test(`manager rows as a space manager, ${scheme} ${width}`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        "/settings/spaces?hosted=1&mock=space-manager&space=SpEngNpQrSt2uVwX",
      );
      const card = page.getByRole("region", { name: "People" });
      await expect(card.getByText("Rina Patel")).toBeVisible();
      for (const name of ["Rina Patel", "Max Weber"]) {
        const row = card.getByRole("listitem").filter({ hasText: name });
        await expect(row.getByRole("combobox")).toHaveCount(0);
        await expect(row.getByRole("button", { name: /More for/ })).toHaveCount(
          0,
        );
        await expect(row.getByText("Manager", { exact: true })).toBeVisible();
      }
      const bob = card.getByRole("listitem").filter({ hasText: "Bob Builder" });
      await expect(bob.getByRole("combobox")).toBeVisible();
      await card.scrollIntoViewIfNeeded();
      await settle(page);
      await page.screenshot({
        path: info.outputPath(`manager-rows-${scheme}-${width}.png`),
      });
    });
