// #189: toggle, then helper text, then a gap, then an aligned action row.
import { expect, test } from "@playwright/test";

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test(`visibility confirmation layout at ${width} (${scheme})`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/");
      await page.getByRole("link", { name: "Landing page" }).first().click();
      await page.waitForURL(/\/a\//);
      await page.goto(`${page.url().split("?")[0]}?panel=open&tab=share`);
      await page.getByRole("radio", { name: "Public" }).click();
      const save = page.getByRole("button", { name: "Save visibility" });
      const cancel = page.getByRole("button", { name: "Cancel" });
      await expect(save).toBeVisible();

      const box = async (l: ReturnType<typeof page.locator>) => {
        const b = await l.boundingBox();
        if (!b) throw new Error("not laid out");
        return b;
      };
      const group = await box(
        page.getByRole("radiogroup", { name: "Visibility" }),
      );
      const note = await box(page.locator(".oa-vis-note"));
      const s = await box(save);
      const c = await box(cancel);
      // Helper text sits under the toggle, the actions come after it.
      expect(note.y).toBeGreaterThanOrEqual(group.y + group.height);
      expect(s.y - (note.y + note.height)).toBeGreaterThanOrEqual(12);
      // Save and Cancel share one row, with the same height and center line.
      expect(Math.abs(s.height - c.height)).toBeLessThanOrEqual(1);
      expect(
        Math.abs(s.y + s.height / 2 - (c.y + c.height / 2)),
      ).toBeLessThanOrEqual(1);
      expect(c.x).toBeGreaterThan(s.x + s.width);
      await info.attach(`visibility-${width}-${scheme}`, {
        body: await page.locator(".oa-share section").first().screenshot(),
        contentType: "image/png",
      });
    });
