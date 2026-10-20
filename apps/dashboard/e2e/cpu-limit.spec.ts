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
  // The mock answers the first two library requests of every load with a 1102,
  // so the list arrives after the library's retry backoff.
  await expect(page.getByRole("article").first()).toBeVisible({
    timeout: 30_000,
  });
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
  // The notice fires SLOW_MS after the frame loads. A fake clock replaces the
  // wait, and a counter of frame loads says when the timer is armed: the load
  // listener (React's onLoad) runs in the same dispatch as ours, so once the
  // count is seen the timer exists and one fast-forward fires it. No retries,
  // no sleeps, and nothing depends on how long the machine takes.
  await page.clock.install();
  await page.addInitScript(() => {
    const w = window as unknown as { __frameLoads: number };
    w.__frameLoads = 0;
    document.addEventListener(
      "load",
      (e) => {
        if ((e.target as Element).tagName === "IFRAME") w.__frameLoads++;
      },
      true,
    );
  });
  // A frame that loads but never says hello.
  await page.route("https://content.example.com/**", (r) =>
    r.fulfill({ contentType: "text/html", body: "<p>No runtime here</p>" }),
  );
  await page.goto("/a/Ef7hJkLmNp8qRsTv?mock=cpu");
  const notice = page.locator(".oa-vnotice");
  const frame = page.locator("iframe.oa-vframe");
  await expect(frame).toBeVisible();
  await expect(notice).toHaveCount(0);
  let loads = 0;
  const slow = async () => {
    loads++;
    await page.waitForFunction(
      (n) => (window as unknown as { __frameLoads: number }).__frameLoads >= n,
      loads,
    );
    await page.clock.fastForward(8_000);
    await expect(notice).toBeVisible();
  };
  await slow();
  // Usage (the CPU signal) can land after the notice; wait on it, not on time.
  await expect(notice).toContainText(
    "This artifact may have hit your instance's CPU limit. Reloading usually works.",
  );
  await expect(frame).toBeVisible();
  await expect(notice).not.toContainText("Workers Paid");
  for (let i = 0; i < 2; i++) {
    await notice.getByRole("button", { name: "Reload" }).click();
    await expect(notice).toHaveCount(0);
    await slow();
  }
  await expect(notice).toContainText("Workers Paid raises the limit.");
  await expect(notice.getByRole("link", { name: /See plans/ })).toBeVisible();
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);
  await expect(frame).toBeVisible();
});
