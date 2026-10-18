import { expect, publishViaApi, test, uniq } from "./fixtures";

test("library alone captures a missing thumbnail in the background", async ({
  page,
  member,
}) => {
  const title = `Bg ${uniq()}`;
  const { id } = await publishViaApi(member.pat, {
    title,
    format: "html",
    content:
      '<!doctype html><body style="background:#2563eb;color:#fff"><h1>Background thumb</h1></body>',
  });
  // Never the viewer: only the library is opened.
  const viewer = new RegExp(`/a/${id}`);
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame() && viewer.test(f.url()))
      throw new Error("the viewer was opened");
  });

  await page.goto("/");
  const card = page.locator("article.lib-card").filter({ hasText: title });
  await expect(card).toBeVisible();
  const img = card.locator(".lib-thumb img[data-ready]");
  await expect(img).toBeVisible({ timeout: 20_000 });
  await expect(img).toHaveAttribute(
    "src",
    new RegExp(`/api/v1/artifacts/${id}/thumbnail$`),
  );
  // A real, decoded image, not a broken one.
  expect(
    await img.evaluate((el: HTMLImageElement) => el.naturalWidth),
  ).toBeGreaterThan(0);
  // The capture frame is gone once done.
  await expect(page.locator("iframe[sandbox='allow-scripts']")).toHaveCount(0);
  await expect(page).not.toHaveURL(viewer);
});
