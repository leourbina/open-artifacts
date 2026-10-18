import { QUOTA_MESSAGE } from "@oa/shared";
import { expect, test } from "@playwright/test";

test("library shows the quota banner when the API reports quota_exceeded", async ({
  page,
}) => {
  await page.goto("/?mock=quota");
  await expect(
    page.getByRole("status").filter({ hasText: QUOTA_MESSAGE }),
  ).toBeVisible();
  await expect(page.getByText(QUOTA_MESSAGE, { exact: true })).toHaveText(
    QUOTA_MESSAGE,
  );
});

test("no banner without quota mode", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Library" }).first(),
  ).toBeVisible();
  await expect(page.getByText(QUOTA_MESSAGE)).toHaveCount(0);
  await expect(page.getByRole("article").first()).toBeVisible();
});
