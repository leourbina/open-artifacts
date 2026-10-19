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
