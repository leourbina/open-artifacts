import type { BrowserContext, Page } from "@playwright/test";
import {
  APP,
  artifactFrame,
  EMBEDDER,
  expect,
  publishViaApi,
  test,
  uniq,
} from "./fixtures";

// A plain link to another artifact on this instance: the runtime asks the
// shell to navigate, so the top window moves (client-side) instead of the
// sandboxed frame loading the app and being refused.
test("a plain link to /a/B lands the top window on B", async ({
  page,
  member,
}) => {
  const b = await publishViaApi(member.pat, {
    title: `Link target ${uniq()}`,
    entry: "index.html",
    files: { "index.html": `<!doctype html><p id="who">B</p>` },
  });
  const a = await publishViaApi(member.pat, {
    title: `Link source ${uniq()}`,
    entry: "index.html",
    files: {
      "index.html": `<!doctype html><p id="who">A</p><a id="go" href="${APP}/a/${b.id}">Open B</a>`,
    },
  });
  await page.goto(`/a/${a.id}`);
  const frame = artifactFrame(page);
  await expect(frame.locator("#who")).toHaveText("A");
  await page.evaluate(() => {
    (window as unknown as { __same: boolean }).__same = true;
  });
  // The runtime intercepts only after the welcome: wait for the bridge.
  await frame
    .locator("body")
    .evaluate(
      () =>
        (window as unknown as { openArtifacts: { ready: Promise<unknown> } })
          .openArtifacts.ready,
    );
  await frame.locator("#go").click();
  await expect(page).toHaveURL(`${APP}/a/${b.id}`);
  await expect(frame.locator("#who")).toHaveText("B");
  expect(
    await page.evaluate(
      () => (window as unknown as { __same?: boolean }).__same,
    ),
  ).toBe(true);
});

// Any other plain link (#P0): the runtime asks the shell to "open" it, and the
// shell moves the top window, in the same tab, only on a real click (transient
// user activation); otherwise a toast asks first. javascript: and friends are
// refused; target=_blank and embed mode keep a new tab.
const OUTSIDE = "https://outside.example";

/** Serves the outside site so nothing leaves the machine. */
const serveOutside = (ctx: BrowserContext) =>
  ctx.route(`${OUTSIDE}/**`, (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Outside</title><h1 id="out">outside ${new URL(r.request().url()).pathname}</h1>`,
    }),
  );

/** Waits for the welcome; retried, since a frame may still be (re)loading. */
const ready = (page: Page) =>
  expect(async () => {
    await artifactFrame(page)
      .locator("body")
      .evaluate(
        () =>
          (window as unknown as { openArtifacts: { ready: Promise<unknown> } })
            .openArtifacts.ready,
      );
  }).toPass();

/** The per-load nonce, from the frame's #oa= hash. */
const nonceOf = async (page: Page) => {
  // The bridge sets the src property (no attribute).
  const src = await page
    .locator("iframe.oa-vframe")
    .evaluate((f) => (f as HTMLIFrameElement).src);
  return new URL(src).hash.replace(/^#oa=/, "");
};

const LINKS = `<!doctype html><p id="who">links</p>
<a id="ext" href="${OUTSIDE}/landing">Outside</a>
<a id="blank" href="${OUTSIDE}/tab" target="_blank">Outside, new tab</a>
<button id="post" type="button" onclick="parent.postMessage(JSON.parse(this.dataset.msg), '*')">Post</button>`;

const publishLinks = (pat: string, extra: Record<string, unknown> = {}) =>
  publishViaApi(pat, {
    title: `Links ${uniq()}`,
    format: "html",
    content: LINKS,
    ...extra,
  });

test("an external plain link moves the top window, same tab", async ({
  page,
  member,
}) => {
  await serveOutside(page.context());
  const a = await publishLinks(member.pat);
  await page.goto(`/a/${a.id}`);
  await ready(page);
  await artifactFrame(page).locator("#ext").click();
  await expect(page).toHaveURL(`${OUTSIDE}/landing`);
  await expect(page.locator("#out")).toHaveText("outside /landing");
  expect(page.context().pages()).toHaveLength(1);
});

test("target=_blank opens a new tab and leaves the viewer", async ({
  page,
  member,
}) => {
  await serveOutside(page.context());
  const a = await publishLinks(member.pat);
  await page.goto(`/a/${a.id}`);
  await ready(page);
  const [tab] = await Promise.all([
    page.context().waitForEvent("page"),
    artifactFrame(page).locator("#blank").click(),
  ]);
  await expect(tab).toHaveURL(`${OUTSIDE}/tab`);
  expect(page.url()).toBe(`${APP}/a/${a.id}`);
});

test("javascript:, data:, app pages and the content host are refused on a real click", async ({
  page,
  member,
}) => {
  const a = await publishLinks(member.pat);
  page.on("dialog", (d) => {
    throw new Error(`unexpected dialog: ${d.message()}`);
  });
  await page.goto(`/a/${a.id}`);
  await ready(page);
  const nonce = await nonceOf(page);
  const content = new URL(
    await page
      .locator("iframe.oa-vframe")
      .evaluate((f) => (f as HTMLIFrameElement).src),
  ).origin;
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,hi",
    // The app outside viewer paths (consent phishing, invites, actions).
    `${APP}/oauth/authorize?client_id=evil`,
    `${APP}/settings`,
    // The content host.
    `${content}/p/${a.id}/v1/index.html`,
  ]) {
    await artifactFrame(page)
      .locator("#post")
      .evaluate(
        (b, msg) => {
          (b as HTMLElement).dataset.msg = JSON.stringify(msg);
        },
        { oa: 1, type: "open", url, nonce },
      );
    // A real click: the shell has user activation, and still refuses.
    await artifactFrame(page).locator("#post").click();
    await page.waitForTimeout(1_100); // past the 1/s limit
  }
  expect(page.url()).toBe(`${APP}/a/${a.id}`);
  await expect(page.getByText(/^Open link to/)).toHaveCount(0);
});

test("a script-posted open without user activation asks first; Open goes", async ({
  page,
  member,
}, info) => {
  test.slow();
  await serveOutside(page.context());
  // The artifact forges "open" on its own, with the nonce it can read, long
  // after any activation (5 s in Chromium and WebKit). Nothing here may touch
  // the page before it fires: Playwright's evaluate and polling count as user
  // gestures.
  const a = await publishLinks(member.pat, {
    content: `${LINKS}<script>setTimeout(() => parent.postMessage({ oa: 1, type: "open", url: "${OUTSIDE}/forged", nonce: window.__oaShellNonce.n }, "*"), 12000)</script>`,
  });
  await page.goto(`/a/${a.id}`);
  await expect(artifactFrame(page).locator("#who")).toHaveText("links");
  // Idle until the post: Playwright's own polling also counts as a gesture.
  await page.waitForTimeout(13_000);
  const ask = page.getByText("Open link to outside.example?");
  await expect(ask).toBeVisible();
  expect(page.url()).toBe(`${APP}/a/${a.id}`);
  // Focus stays where it was.
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe(
    "BUTTON",
  );
  if (info.project.name === "chromium")
    for (const width of [1280, 390])
      for (const scheme of ["light", "dark"] as const) {
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ colorScheme: scheme });
        await page.screenshot({
          path: info.outputPath(`open-link-toast-${width}-${scheme}.png`),
        });
      }
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page).toHaveURL(`${OUTSIDE}/forged`);
});

test("embed mode: an external plain link opens a new tab", async ({
  browser,
  member,
}) => {
  const a = await publishLinks(member.pat, { visibility: "public" });
  const ctx = await browser.newContext();
  await serveOutside(ctx);
  const page = await ctx.newPage();
  const host = `${EMBEDDER}/host?src=${encodeURIComponent(`/a/${a.id}/full`)}`;
  await page.goto(host);
  const art = page.frameLocator("#app").frameLocator("iframe.oa-vframe");
  await expect(art.locator("#who")).toHaveText("links");
  await art
    .locator("body")
    .evaluate(
      () =>
        (window as unknown as { openArtifacts: { ready: Promise<unknown> } })
          .openArtifacts.ready,
    );
  const [tab] = await Promise.all([
    ctx.waitForEvent("page"),
    art.locator("#ext").click(),
  ]);
  await expect(tab).toHaveURL(`${OUTSIDE}/landing`);
  expect(page.url()).toBe(host);
  await ctx.close();
});

test("a relative link to the artifact's own page still loads in the frame", async ({
  page,
  member,
}) => {
  const a = await publishViaApi(member.pat, {
    title: `Pages ${uniq()}`,
    entry: "index.html",
    files: {
      "index.html": `<!doctype html><p id="who">page 1</p><a id="next" href="page2.html">Next</a>`,
      "page2.html": `<!doctype html><p id="who">page 2</p>`,
    },
  });
  await page.goto(`/a/${a.id}`);
  await ready(page);
  await artifactFrame(page).locator("#next").click();
  await expect(artifactFrame(page).locator("#who")).toHaveText("page 2");
  expect(page.url()).toBe(`${APP}/a/${a.id}`);
  expect(page.context().pages()).toHaveLength(1);
});

test("http asks with a not-secure warning; the port shows when not the default", async ({
  page,
  member,
}, info) => {
  test.slow();
  const a = await publishLinks(member.pat, {
    content: `${LINKS}<script>setTimeout(() => parent.postMessage({ oa: 1, type: "open", url: "http://plain.example:8080/x", nonce: window.__oaShellNonce.n }, "*"), 12000)</script>`,
  });
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`/a/${a.id}`);
  await expect(artifactFrame(page).locator("#who")).toHaveText("links");
  await page.waitForTimeout(13_000);
  await expect(
    page.getByText("Open link to plain.example:8080?"),
  ).toBeVisible();
  await expect(
    page.getByText("Not secure: this site doesn't use HTTPS."),
  ).toBeVisible();
  if (info.project.name === "chromium")
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({
        path: info.outputPath(`open-link-http-390-${scheme}.png`),
      });
    }
});
