// M1 fixes without a reviewer test: side panel focus ring (11) and the title bar button size (12).
import { expect, test } from "@playwright/test";

test("side panel shows a focus ring on the active tab when it takes focus", async ({
  page,
}) => {
  await page.goto("/a/Cd5fGhJkLm6nPqRs");
  await page.getByRole("button", { name: "Versions" }).click();
  const tab = page.getByRole("tab", { name: "Versions" });
  await expect(tab).toBeFocused();
  const ring = await tab.evaluate((e) => {
    const c = getComputedStyle(e);
    return (
      (c.outlineStyle !== "none" && Number.parseFloat(c.outlineWidth) > 0) ||
      c.boxShadow !== "none"
    );
  });
  expect(ring).toBe(true);
});

test("Full screen matches the height of its neighbours", async ({ page }) => {
  await page.goto("/a/Cd5fGhJkLm6nPqRs");
  const raw = page.getByRole("link", { name: "Full screen" });
  const versions = page.getByRole("button", { name: "Versions" });
  await expect(raw).toBeVisible();
  const h = async (l: typeof raw) => (await l.boundingBox())?.height;
  expect(await h(raw)).toBe(await h(versions));
});
