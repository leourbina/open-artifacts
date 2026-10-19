// #167: with email off, adding a member or sharing shows the link to send;
// with it on (?mock=email, ?mock=email-fail) the copy says what was emailed.
import { expect, test } from "@playwright/test";

test("adding a member confirms with the sign-in link and copies it", async ({
  page,
  context,
  baseURL,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/settings/members");
  await page.getByRole("button", { name: "Add member" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("doesn't send invitations");
  await dialog.getByLabel("Email").fill("new.person@example.com");
  await dialog.getByRole("button", { name: "Add member" }).click();
  await expect(
    dialog.getByRole("heading", {
      name: "new.person@example.com can now sign in",
    }),
  ).toBeVisible();
  const origin = new URL(baseURL ?? page.url()).origin;
  await expect(
    dialog.getByRole("textbox", { name: "Sign-in link" }),
  ).toHaveValue(origin);
  await expect(dialog).toContainText(`They'll sign in at ${origin}`);
  await dialog.getByRole("button", { name: "Copy link" }).click();
  await expect(dialog.getByRole("button", { name: /Copied/ })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    origin,
  );
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
});

test("sharing confirms with the artifact link", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Landing page" }).first().click();
  await page.waitForURL(/\/a\//);
  const viewer = page.url().split("?")[0] as string;
  await page.goto(`${viewer}?panel=open&tab=share`);
  await expect(
    page.getByText("No email is sent. Copy the link and share it yourself."),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Email" }).fill("eve@example.com");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Shared with eve@example.com")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Artifact link" }),
  ).toHaveValue(viewer);
});

test("email on: the invite is emailed, and the dialog says so", async ({
  page,
  baseURL,
}) => {
  await page.goto("/settings/members?mock=email");
  await page.getByRole("button", { name: "Add member" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "We'll email them a link to Acme Artifacts. They'll sign in with a one-time code.",
  );
  await dialog.getByLabel("Email").fill("new.person@example.com");
  await dialog.getByRole("button", { name: "Add member" }).click();
  await expect(
    dialog.getByRole("heading", {
      name: "Invitation sent to new.person@example.com",
    }),
  ).toBeVisible();
  const origin = new URL(baseURL ?? page.url()).origin;
  await expect(dialog).toContainText(
    `They can also sign in at ${origin} with a one-time code.`,
  );
  await expect(
    dialog.getByRole("textbox", { name: "Sign-in link" }),
  ).toHaveValue(origin);
});

test("email on but the send failed: the link to send, and why", async ({
  page,
}) => {
  await page.goto("/settings/members?mock=email-fail");
  await page.getByRole("button", { name: "Add member" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email").fill("new.person@example.com");
  await dialog.getByRole("button", { name: "Add member" }).click();
  await expect(
    dialog.getByRole("heading", {
      name: "new.person@example.com can now sign in",
    }),
  ).toBeVisible();
  await expect(dialog).toContainText(
    "The email didn't send. Copy the link and share it yourself.",
  );
});

test("email on: sharing says the link was emailed", async ({ page }) => {
  await page.goto("/a/Cd5fGhJkLm6nPqRs?mock=email&panel=open&tab=share");
  await expect(
    page.getByText(
      "We'll email them a link. You can also copy it and send it yourself.",
    ),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Email" }).fill("eve@example.com");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Shared with eve@example.com")).toBeVisible();
  await expect(
    page.getByText(
      "We emailed them a link. They'll sign in with a one-time code.",
    ),
  ).toBeVisible();
});
