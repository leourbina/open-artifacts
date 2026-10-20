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
          await expect(requests).toContainText("182,400");
          await expect(requests).not.toContainText("today");
          await expect(
            page.getByRole("meter", { name: "Worker requests" }),
          ).toHaveCount(0);
          await expect(main).not.toContainText(/\/ [\d,]+ today/);
          await expect(main).toContainText("of 30 s");
          await expect(main).not.toContainText("of 10 ms");
          await expect(main).not.toContainText(PLAN_LINE);
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
