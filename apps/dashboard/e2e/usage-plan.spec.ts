// Usage per plan (#279): Free shows daily caps and the 10 ms CPU line;
// Paid shows counts without caps or bars and "of 30 s". Each run attaches a
// screenshot for review.
import { expect, test } from "@playwright/test";

const PLAN_LINE = "Workers Free is sized for one person.";

for (const plan of ["free", "paid"] as const)
  for (const width of [1280, 390])
    for (const theme of ["light", "dark"])
      test(`usage on ${plan} at ${width}px ${theme}`, async ({
        page,
      }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(
          `/settings/usage?mock=${plan === "free" ? "cpu" : "paid"}`,
        );
        await page.evaluate(
          (t) => document.documentElement.setAttribute("data-theme", t),
          theme,
        );
        const main = page.locator("#oa-main");
        await expect(page.getByRole("region", { name: "CPU" })).toBeVisible();
        const requests = page.getByRole("region", { name: "Worker requests" });
        if (plan === "free") {
          await expect(requests).toContainText("/ 100,000 today");
          await expect(
            page.getByRole("meter", { name: "Worker requests" }),
          ).toBeVisible();
          await expect(main).toContainText("of 10 ms");
          await expect(main).toContainText(PLAN_LINE);
        } else {
          await expect(requests).toContainText("182,400today");
          await expect(requests).not.toContainText("/");
          await expect(
            page.getByRole("meter", { name: "Worker requests" }),
          ).toHaveCount(0);
          await expect(main).not.toContainText(/\/ [\d,]+ today/);
          await expect(main).toContainText("of 30 s");
          await expect(main).not.toContainText("of 10 ms");
          await expect(main).not.toContainText(PLAN_LINE);
          await expect(main).toContainText(
            "This instance is on Workers Paid. There are no daily limits",
          );
          await expect(
            page.getByRole("link", { name: /See pricing/ }),
          ).toHaveAttribute(
            "href",
            "https://developers.cloudflare.com/workers/platform/pricing/",
          );
        }
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
          ),
        ).toBe(0);
        await info.attach(`usage-${plan}-${width}-${theme}`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        });
      });

// An uncapped card keeps a capped card's height (Design, #279).
for (const width of [1280, 390])
  test(`uncapped and capped meter cards are equally tall at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const heights = async (mock: string) => {
      await page.goto(`/settings/usage?mock=${mock}`);
      await expect(page.getByRole("region", { name: "CPU" })).toBeVisible();
      return page.evaluate(() =>
        [
          ...document.querySelectorAll<HTMLElement>(
            "#oa-main section[aria-labelledby^=oa-meter-] [data-slot=card]",
          ),
        ].map((c) => c.getBoundingClientRect().height),
      );
    };
    const capped = await heights("cpu");
    const uncapped = await heights("paid");
    expect(capped.length).toBe(4);
    expect(uncapped.length).toBe(5);
    for (const h of [...capped, ...uncapped])
      expect(Math.abs(h - (capped[0] ?? 0))).toBeLessThanOrEqual(0.5);
  });
