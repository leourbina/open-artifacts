import { expect, test } from "@playwright/test";

test("artifact detail has no upload-version control", async ({ page }) => {
  await page.goto("/a/Cd5fGhJkLm6nPqRs");
  await expect(page.getByRole("button", { name: "Share" })).toBeVisible();
  await expect(page.getByText(/upload version/i)).toHaveCount(0);
  await expect(page.getByTestId("upload-files")).toHaveCount(0);
});
