// M1 fixes without a reviewer test: side panel focus ring (11) and Open raw size (12).
import { expect, test } from "@playwright/test";

test("side panel shows a focus ring when it takes focus", async ({ page }) => {
  await page.goto("/a/Cd5fGhJkLm6nPqRs");
  await page.getByRole("button", { name: "Versions" }).click();
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await expect(panel).toBeFocused();
  const ring = await panel.evaluate((e) => {
    const c = getComputedStyle(e);
    return (
      (c.outlineStyle !== "none" && Number.parseFloat(c.outlineWidth) > 0) ||
      c.boxShadow !== "none"
    );
  });
  expect(ring).toBe(true);
});

test("Open raw matches the height of its neighbours", async ({ page }) => {
  await page.goto("/a/Cd5fGhJkLm6nPqRs");
  const raw = page.getByRole("button", { name: "Open raw" });
  const versions = page.getByRole("button", { name: "Versions" });
  await expect(raw).toBeVisible();
  const h = async (l: typeof raw) => (await l.boundingBox())?.height;
  expect(await h(raw)).toBe(await h(versions));
});
