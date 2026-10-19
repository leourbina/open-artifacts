import { expect, test } from "@playwright/test";

const TITLE = "What do you like to be called?";

test("display-name dialog: Save sends the trimmed name and closes", async ({
  page,
}) => {
  await page.goto("/?mock=name");
  const dialog = page.getByRole("dialog", { name: TITLE });
  await expect(dialog).toBeVisible();
  const field = dialog.getByLabel("Your name");
  await expect(field).toHaveValue("Ada Lovelace");
  await expect(field).toBeFocused();
  await field.fill("  Ada L.  ");
  const patch = page.waitForRequest(
    (r) => r.method() === "PATCH" && r.url().endsWith("/api/v1/me"),
  );
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  expect((await patch).postDataJSON()).toEqual({ displayName: "Ada L." });
  await expect(dialog).toBeHidden();
});

test("display-name dialog: Not now hides it for the rest of the session", async ({
  page,
}) => {
  await page.goto("/?mock=name");
  const dialog = page.getByRole("dialog", { name: TITLE });
  await dialog.getByRole("button", { name: "Not now" }).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Library", level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("display-name dialog: Escape dismisses, a backdrop click doesn't", async ({
  page,
}) => {
  await page.goto("/?mock=name");
  const dialog = page.getByRole("dialog", { name: TITLE });
  await expect(dialog).toBeVisible();
  await page.mouse.click(10, 10);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("Settings → Profile saves the display name", async ({ page }) => {
  await page.goto("/settings/profile");
  await expect(page.getByRole("link", { name: "Profile" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();
  await expect(page.getByLabel("Email")).toHaveValue("ada@example.com");
  await page.getByLabel("Display name").fill(" Ada Lovelace ");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  const patch = page.waitForRequest(
    (r) => r.method() === "PATCH" && r.url().endsWith("/api/v1/me"),
  );
  await save.click();
  expect((await patch).postDataJSON()).toEqual({
    displayName: "Ada Lovelace",
  });
  await expect(
    page.getByText("Display name saved", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
});
