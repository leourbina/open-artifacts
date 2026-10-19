import { expect, test } from "@playwright/test";

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme });

    test("split at 1280", async ({ page }, info) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto("/sign-in");
      const brand = await page.locator(".oa-split-brand").boundingBox();
      const form = await page.locator(".oa-split-form").boundingBox();
      if (!brand || !form) throw new Error("missing panels");
      expect(brand.x).toBe(0);
      expect(form.x).toBeGreaterThan(brand.x + brand.width - 1);
      expect(brand.y).toBe(form.y);
      expect(brand.height).toBe(800);
      // Form content is vertically centred in its half.
      const box = (await page.locator(".oa-split-formbox").boundingBox())!;
      expect(Math.abs(box.y + box.height / 2 - 400)).toBeLessThan(8);
      await expect(
        page.getByRole("heading", { name: "Sign in" }),
      ).toBeVisible();
      await page.screenshot({
        path: info.outputPath(`signin-${scheme}-1280.png`),
      });
    });

    test("header strip at 390", async ({ page }, info) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/sign-in");
      const brand = (await page.locator(".oa-split-brand").boundingBox())!;
      const form = (await page.locator(".oa-split-form").boundingBox())!;
      expect(brand.width).toBe(390);
      expect(form.y).toBeGreaterThanOrEqual(brand.y + brand.height - 1);
      const sw = await page.evaluate(
        () => document.documentElement.scrollWidth,
      );
      expect(sw).toBeLessThanOrEqual(390);
      await page.screenshot({
        path: info.outputPath(`signin-${scheme}-390.png`),
      });
    });
  });
}
