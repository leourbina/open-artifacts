// The Agents page must not scroll sideways at 390px.
import { expect, test } from "@playwright/test";

test("Agents page has no horizontal page scroll at 390px (token variant)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/agents");
  await page.getByRole("radio", { name: "Token" }).click();
  await expect(page.getByText(/claude mcp add/)).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});
