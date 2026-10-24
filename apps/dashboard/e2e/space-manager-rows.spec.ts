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
      // One muted line under the intro for a non-admin manager.
      await expect(
        card.getByText("Only an admin can change another manager's access."),
      ).toHaveCount(1);
      if (width <= 600) {
        // The role text lines up with the select's left edge.
        const rina = card
          .getByRole("listitem")
          .filter({ hasText: "Rina Patel" });
        const text = await rina
          .getByText("Manager", { exact: true })
          .boundingBox();
        const select = await bob.getByRole("combobox").boundingBox();
        if (!text || !select) throw new Error("no boxes");
        expect(Math.abs(text.x - select.x)).toBeLessThan(1.5);
      }
      await card.scrollIntoViewIfNeeded();
      await settle(page);
      await page.screenshot({
        path: info.outputPath(`manager-rows-${scheme}-${width}.png`),
      });
    });
