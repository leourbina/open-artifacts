import {
  APP,
  artifactFrame,
  expect,
  loginAs,
  publishViaApi,
  test,
  uniq,
} from "./fixtures";

const BOB = "bob@x.com";

test("owner shares with Bob as viewer; Bob sees it in Shared; revoked, Bob gets a 404", async ({
  page,
  member,
  browser,
}) => {
  const title = `Plan ${uniq()}`;
  const { id } = await publishViaApi(member.pat, {
    title,
    format: "markdown",
    content: "# The plan",
  });
  await page.goto(`/a/${id}`);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByRole("textbox", { name: "Email" }).fill(BOB);
  await expect(page.getByRole("combobox", { name: "Invite role" })).toHaveText(
    "Viewer",
  );
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const remove = page.getByRole("button", { name: `Remove ${BOB}` });
  await expect(remove).toBeVisible();
  // #167: no email is sent, so the owner gets the link to pass on.
  await expect(page.getByText(`Shared with ${BOB}`)).toBeVisible();
  const link = await page
    .getByRole("textbox", { name: "Artifact link" })
    .inputValue();
  expect(link).toBe(`${new URL(page.url()).origin}/a/${id}`);

  const bobCtx = await browser.newContext({ baseURL: APP });
  const bob = await bobCtx.newPage();
  await loginAs(bob, BOB, "guest");
  await bob.goto("/shared");
  await expect(
    bob.getByRole("link", { name: title, exact: true }),
  ).toBeVisible();

  // Bob can open it while shared, so the 404 below is the revocation's doing.
  await bob.goto(link);
  await expect(
    artifactFrame(bob).getByRole("heading", { name: "The plan" }),
  ).toBeVisible();

  await remove.click();
  await expect(remove).toHaveCount(0);

  // Bob is shared across projects, so the list may hold others' artifacts:
  // wait for it to load, then check this one is gone.
  const listed = bob.waitForResponse(
    (r) =>
      r.url().includes("/api/v1/artifacts?") &&
      r.url().includes("scope=shared"),
  );
  await bob.goto("/shared");
  expect((await listed).ok()).toBe(true);
  await expect(
    bob.getByRole("status", { name: "Loading artifacts" }),
  ).toHaveCount(0);
  await expect(bob.getByRole("link", { name: title, exact: true })).toHaveCount(
    0,
  );

  await bob.goto(`/a/${id}`);
  await expect(
    bob.getByRole("heading", { name: "Page not found" }),
  ).toBeVisible();
  await expect(bob.locator("iframe")).toHaveCount(0);
  await bobCtx.close();
});
