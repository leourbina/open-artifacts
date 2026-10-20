import { expect, type Page, test } from "@playwright/test";

const TITLE = "Some requests hit Cloudflare's free CPU limit";
const banner = (page: Page) =>
  page.getByRole("status").filter({ hasText: TITLE });

test("owner: the CPU banner shows today's hits and stays dismissed for the day", async ({
  page,
}) => {
  await page.goto("/?mock=cpu");
  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toContainText(
    "Your instance hit the limit 4 times today",
  );
  await expect(page.getByRole("link", { name: /See plans/ })).toHaveAttribute(
    "href",
    "https://dash.cloudflare.com/?to=/:account/workers/plans",
  );
  // At 1280 the banner lines up with the page's content column.
  await page.setViewportSize({ width: 1280, height: 900 });
  const [b, h1] = await Promise.all([
    banner(page).boundingBox(),
    page.getByRole("heading", { name: "Library", level: 1 }).boundingBox(),
  ]);
  expect(Math.abs((b?.x ?? 0) - (h1?.x ?? -1))).toBeLessThanOrEqual(0.5);
  await banner(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(banner(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("article").first()).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
});

test("member: a real 1102 response raises the member banner", async ({
  page,
}) => {
  await page.goto("/?mock=cpu&role=member");
  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toContainText(
    "A request just hit Cloudflare's free CPU limit.",
  );
  await expect(banner(page)).toContainText(
    "Ask your instance owner about upgrading.",
  );
  await expect(page.getByRole("link", { name: /See plans/ })).toHaveCount(0);
  await expect(page.getByRole("article").first()).toBeVisible();
});

test("no CPU banner without CPU trouble", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("article").first()).toBeVisible();
  await expect(page.getByText(TITLE)).toHaveCount(0);
});

test("viewer: a silent frame gets the CPU notice above it, upsell after 2 reloads", async ({
  page,
}) => {
  test.setTimeout(60_000);
  // A frame that loads but never says hello.
  await page.route("https://content.example.com/**", (r) =>
    r.fulfill({ contentType: "text/html", body: "<p>No runtime here</p>" }),
  );
  await page.goto("/a/Ef7hJkLmNp8qRsTv?mock=cpu");
  const notice = page.locator(".oa-vnotice");
  const frame = page.locator("iframe.oa-vframe");
  await expect(frame).toBeVisible();
  await expect(notice).toHaveCount(0);
  await expect(notice).toContainText(
    "This artifact may have hit your instance's CPU limit. Reloading usually works.",
    { timeout: 12_000 },
  );
  await expect(frame).toBeVisible();
  await expect(notice).not.toContainText("Workers Paid");
  for (let i = 0; i < 2; i++) {
    await notice.getByRole("button", { name: "Reload" }).click();
    await expect(notice).toHaveCount(0);
    await expect(notice).toBeVisible({ timeout: 12_000 });
  }
  await expect(notice).toContainText("Workers Paid raises the limit.");
  await expect(notice.getByRole("link", { name: /See plans/ })).toBeVisible();
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);
  await expect(frame).toBeVisible();
});

test("Paid: the banner reports the 30-second limit with no upgrade pitch (#279)", async ({
  page,
}) => {
  await page.goto("/?mock=paid-cpu");
  const paid = page
    .getByRole("status")
    .filter({ hasText: "Some requests hit Cloudflare's CPU limit" });
  await expect(paid).toBeVisible();
  await expect(paid).toContainText(
    "Your instance hit the 30-second per-request limit 4 times today.",
  );
  await expect(paid.getByRole("link", { name: "View usage" })).toBeVisible();
  await expect(
    paid.getByRole("link", { name: /Report an issue/ }),
  ).toHaveAttribute(
    "href",
    "https://github.com/open-artifacts-ai/open-artifacts/issues/new",
  );
  await expect(paid).not.toContainText("Workers Paid");
  await paid.getByRole("link", { name: "View usage" }).click();
  await expect(page).toHaveURL(/\/settings\/usage/);
});

test("Paid: a silent frame gets the 30-second notice (#279)", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.route("https://content.example.com/**", (r) =>
    r.fulfill({ contentType: "text/html", body: "<p>No runtime here</p>" }),
  );
  await page.goto("/a/Ef7hJkLmNp8qRsTv?mock=paid-cpu");
  const notice = page.locator(".oa-vnotice");
  await expect(notice).toContainText(
    "This request hit Cloudflare's 30-second CPU limit. Try again.",
    { timeout: 12_000 },
  );
  await expect(notice.getByRole("link")).toHaveCount(0);
  await expect(page.locator("iframe.oa-vframe")).toBeVisible();
});
