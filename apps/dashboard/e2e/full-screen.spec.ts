// #290 (mock): /a/<id>/full is the frame alone, filling the window; the
// title bar's "Full screen" opens it in a new tab and the ••• menu copies its
// link. No "Open raw" anywhere.
import { expect, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const)
    test(`full screen at ${width}px ${theme}: the frame fills the window`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/a/${ID}/full`);
      const frame = page.locator("iframe.oa-vframe");
      await expect(frame).toBeVisible();
      expect(await frame.boundingBox()).toEqual({
        x: 0,
        y: 0,
        width,
        height: 800,
      });
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "More actions" }),
      ).toHaveCount(0);
      await info.attach(`full-${width}-${theme}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });

test("Full screen opens /a/<id>/full in a new tab", async ({
  page,
  context,
}) => {
  await page.goto(`/a/${ID}`);
  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("link", { name: "Full screen" }).click(),
  ]);
  await expect(tab).toHaveURL(new RegExp(`/a/${ID}/full$`));
  await expect(tab.locator("iframe.oa-vframe")).toBeVisible();
  await expect(page.getByText("Open raw")).toHaveCount(0);
});

test("the ••• menu copies the full-screen link, with a toast", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/a/${ID}`);
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Open raw" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Copy full-screen link" }).click();
  await expect(page.getByText("Full-screen link copied")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
    new RegExp(`/a/${ID}/full$`),
  );
});

test("phones: Full screen is in the ••• menu", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/a/${ID}`);
  await expect(page.getByRole("link", { name: "Full screen" })).toBeHidden();
  await page.getByRole("button", { name: "More actions" }).click();
  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("menuitem", { name: "Full screen" }).click(),
  ]);
  await expect(tab).toHaveURL(new RegExp(`/a/${ID}/full$`));
});
