/// <reference types="node" />
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { artifactFrame, expect, publishViaApi, test, uniq } from "./fixtures";

/** Console errors and failed /api requests seen during the test. */
function watch(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    // A request the browser cancels on navigation is not a failure; real errors still are.
    const aborted = /ERR_ABORTED|cancelled/i.test(r.failure()?.errorText ?? "");
    if (!aborted && new URL(r.url()).pathname.startsWith("/api/"))
      problems.push(`failed: ${r.method()} ${r.url()}`);
  });
  page.on("response", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/") && r.status() >= 400)
      problems.push(`${r.status()}: ${r.request().method()} ${r.url()}`);
  });
  return problems;
}

/** The viewer for `id` is fully up: title bar, framed content and side panel. */
async function expectDetail(
  page: Page,
  id: string,
  title: string,
  heading: string,
) {
  await expect(page).toHaveURL(new RegExp(`/a/${id}(/v/1)?(\\?|$)`));
  await expect(
    page.locator(".oa-vt").getByRole("heading", { level: 1, name: title }),
  ).toBeVisible();
  await expect(
    artifactFrame(page).getByRole("heading", { level: 1, name: heading }),
  ).toBeVisible();
  const toggle = page.getByRole("button", { name: "Versions", exact: true });
  await toggle.click();
  const panel = page.getByRole("complementary", { name: "Side panel" });
  for (const name of ["Versions", "Share", "Details"])
    await expect(panel.getByRole("tab", { name })).toBeVisible();
  await toggle.click();
  await expect(panel).toHaveCount(0);
}

test("library → detail: card, thumbnail and deep links", async ({
  page,
  member,
}) => {
  const problems = watch(page);
  const tag = uniq();
  const html = {
    title: `Page ${tag}`,
    heading: "Hello page",
    ...(await publishViaApi(member.pat, {
      title: `Page ${tag}`,
      format: "html",
      content:
        '<!doctype html><h1>Hello page</h1><p id="out">waiting</p><script>document.getElementById("out").textContent = "script ran";</script>',
    })),
  };
  const md = {
    title: `Notes ${tag}`,
    heading: "Hello notes",
    ...(await publishViaApi(member.pat, {
      title: `Notes ${tag}`,
      format: "markdown",
      content: "# Hello notes\n\nBody.",
    })),
  };
  const card = (title: string) =>
    page.locator("article.lib-card").filter({ hasText: title });

  for (const a of [html, md]) {
    // The title link.
    await page.goto("/");
    await card(a.title).getByRole("link", { name: a.title }).click();
    await expectDetail(page, a.id, a.title, a.heading);
    if (a === html)
      await expect(artifactFrame(page).locator("#out")).toHaveText(
        "script ran",
      );

    // The thumbnail, where a user naturally clicks.
    await page.goto("/");
    // A mouse click where the user aims, not a locator click: whatever covers the
    // thumbnail (the card's link) must take it.
    const thumb = await card(a.title).locator(".lib-thumb").boundingBox();
    if (!thumb) throw new Error("thumbnail has no box");
    await page.mouse.click(
      thumb.x + thumb.width / 2,
      thumb.y + thumb.height / 2,
    );
    await expectDetail(page, a.id, a.title, a.heading);

    // Deep links.
    await page.reload();
    await expectDetail(page, a.id, a.title, a.heading);
    await page.goto(`/a/${a.id}/v/1`);
    await expectDetail(page, a.id, a.title, a.heading);

    // List view: the row's timestamp, away from the title.
    await page.goto("/?view=list");
    const time = await page
      .locator("article.lib-row")
      .filter({ hasText: a.title })
      .locator("time")
      .boundingBox();
    if (!time) throw new Error("row time has no box");
    await page.mouse.click(time.x + time.width / 2, time.y + time.height / 2);
    await expectDetail(page, a.id, a.title, a.heading);
  }

  // Phone width: no horizontal page scroll; title bar and frame on screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/a/${html.id}`);
  await expect(
    artifactFrame(page).getByRole("heading", { name: html.heading }),
  ).toBeVisible();
  await expect(page.locator(".oa-vt")).toBeInViewport();
  await expect(page.locator("iframe.oa-vframe")).toBeInViewport();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  expect(problems).toEqual([]);

  const shots = process.env.OA_E2E_SHOTS;
  if (shots && test.info().project.name === "chromium")
    for (const width of [1280, 390])
      for (const scheme of ["light", "dark"] as const) {
        await page.setViewportSize({ width, height: width > 400 ? 800 : 844 });
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(
          `/a/${html.id}${width > 400 ? "?panel=open&tab=versions" : ""}`,
        );
        await expect(
          artifactFrame(page).getByRole("heading", { name: html.heading }),
        ).toBeVisible();
        await page.screenshot({
          path: join(shots, `detail-${width}-${scheme}.png`),
        });
      }
});
