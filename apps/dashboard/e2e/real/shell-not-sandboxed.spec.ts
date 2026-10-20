// P0: /a/<id> rendered blank when its document was sandboxed (origin "null"),
// so the shell's module /assets failed CORS. The shell must never be
// sandboxed, whoever opens it and however they got there.
import type { BrowserContext, Page } from "@playwright/test";
import {
  APP,
  artifactFrame,
  expect,
  freshEmail,
  loginAs,
  publishViaApi,
  test,
  uniq,
} from "./fixtures";

/** Collects CORS failures on `page` (console errors and failed requests). */
function corsErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /CORS|cross-origin/i.test(m.text()))
      errors.push(m.text());
  });
  page.on("requestfailed", (r) => {
    if (/CORS|access control/i.test(r.failure()?.errorText ?? ""))
      errors.push(`${r.url()}: ${r.failure()?.errorText}`);
  });
  return errors;
}

/** The shell rendered on a real origin, with no CORS errors. */
async function expectShell(page: Page, errors: string[]) {
  await page.waitForLoadState("load");
  expect(await page.evaluate(() => self.origin)).not.toBe("null");
  await expect(page.locator("iframe.oa-vframe")).toBeVisible();
  expect(errors).toEqual([]);
}

const VIEWERS = ["owner", "member", "non-member", "anonymous"] as const;

for (const path of ["", "/full"]) {
  test(`a public artifact's /a/<id>${path} shell is not sandboxed for every viewer`, async ({
    browser,
    page,
    member,
  }) => {
    const { id } = await publishViaApi(member.pat, {
      title: `Shell ${uniq()}`,
      format: "markdown",
      content: "# Public shell",
      visibility: "public",
    });
    for (const who of VIEWERS) {
      await test.step(who, async () => {
        let ctx: BrowserContext | undefined;
        let p = page;
        if (who !== "owner") {
          ctx = await browser.newContext({ baseURL: APP });
          p = await ctx.newPage();
          if (who === "member") await loginAs(p, freshEmail("other"), "member");
          if (who === "non-member")
            await loginAs(p, freshEmail("guest"), "guest");
        }
        const errors = corsErrors(p);
        await p.goto(`/a/${id}${path}`);
        await expectShell(p, errors);
        await expect(
          artifactFrame(p).getByRole("heading", { name: "Public shell" }),
        ).toBeVisible();
        await ctx?.close();
      });
    }
  });
}

test("a link opened from inside an artifact is not sandboxed", async ({
  page,
  context,
  member,
}) => {
  // Fails until #311 (viewer allow-popups-to-escape-sandbox) and #313 land:
  // the new tab inherits the viewer iframe's sandbox, so its origin is "null".
  test.fail(true, "#311: popups inherit the viewer sandbox");
  const target = await publishViaApi(member.pat, {
    title: `Target ${uniq()}`,
    format: "markdown",
    content: "# Link target",
    visibility: "public",
  });
  const { id } = await publishViaApi(member.pat, {
    title: `Linker ${uniq()}`,
    format: "html",
    content: `<!doctype html><a id="go" target="_blank" href="${APP}/a/${target.id}">Open</a>`,
    visibility: "public",
  });
  await page.goto(`/a/${id}`);
  const popupEvent = context.waitForEvent("page");
  await artifactFrame(page).locator("#go").click();
  const popup = await popupEvent;
  const errors = corsErrors(popup);
  await expectShell(popup, errors);
  await expect(
    artifactFrame(popup).getByRole("heading", { name: "Link target" }),
  ).toBeVisible();
});
