import {
  APP,
  artifactFrame,
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
