import { expect, publishViaApi, test, uniq } from "./fixtures";

const CAPTURE_FRAME = "iframe[sandbox='allow-scripts']";

test("library alone captures a missing thumbnail in the background", async ({
  page,
  member,
}, info) => {
  const title = `Bg ${uniq()}`;
  const { id } = await publishViaApi(member.pat, {
    title,
    format: "html",
    content:
      '<!doctype html><body style="background:#2563eb;color:#fff"><h1>Background thumb</h1></body>',
  });
  // Never the viewer: only the library is opened.
  const viewer = new RegExp(`/a/${id}`);
  let viewerOpened = false;
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame() && viewer.test(f.url())) viewerOpened = true;
  });

  await page.goto("/");
  const card = page.locator("article.lib-card").filter({ hasText: title });
  await expect(card).toBeVisible();

  if (info.project.name === "webkit") {
    // WebKit doesn't isolate frames: no background capture at all.
    await page.waitForTimeout(3_000);
    await expect(page.locator(CAPTURE_FRAME)).toHaveCount(0);
    await expect(card.locator(".lib-thumb img")).toHaveCount(0);
    return;
  }

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
  await expect(page.locator(CAPTURE_FRAME)).toHaveCount(0);
  await expect(page).not.toHaveURL(viewer);
  expect(viewerOpened).toBe(false);
});

test("a hidden frame that grabs focus is killed and the keys stay in the library", async ({
  page,
  member,
}, info) => {
  test.skip(info.project.name === "webkit", "no background capture on WebKit");
  const title = `Thief ${uniq()}`;
  // Never produces a snapshot (no webp encoder), so the frame stays up until the
  // timeout, and starts grabbing focus once the user is in the search box.
  await publishViaApi(member.pat, {
    title,
    format: "html",
    content: `<!doctype html><input id="i"><script>HTMLCanvasElement.prototype.toDataURL=()=>"data:,";setTimeout(()=>setInterval(()=>document.getElementById("i").focus(),20),1000)</script>`,
  });
  const puts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PUT" && r.url().endsWith("/thumbnail"))
      puts.push(r.url());
  });
  await page.goto("/");
  const card = page.locator("article.lib-card").filter({ hasText: title });
  await expect(card).toBeVisible();
  await expect(page.locator(CAPTURE_FRAME)).toHaveCount(1);
  const search = page.getByRole("searchbox", { name: "Search artifacts" });
  await search.click();
  // The frame grabs focus; the library takes it straight back.
  await expect(page.locator(CAPTURE_FRAME)).toHaveCount(0, { timeout: 5_000 });
  expect(puts).toEqual([]);
  await expect(search).toBeFocused();
  await page.keyboard.type("abc");
  await expect(search).toHaveValue("abc");
  await expect(page.locator(CAPTURE_FRAME)).toHaveCount(0);
});
