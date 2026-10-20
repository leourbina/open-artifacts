import { artifactFrame, expect, publishViaApi, test, uniq } from "./fixtures";

// The renavigation notice: a link inside the artifact leaves the page the
// shell loaded (and its nonce), so live data is off until Reload.
const COPY =
  "Live data is off on this page because it opened from a link inside the artifact. Reload to go back to the first page and reconnect.";

const files = {
  "index.html": `<!doctype html>
<p id="out">loading</p>
<a id="next" href="page2.html">Next</a>
<script>
window.openArtifacts.ready
  .then(() => window.openArtifacts.db.collection("notes").get("n1"))
  .then((d) => { document.getElementById("out").textContent = d ? "doc" : "empty"; })
  .catch((e) => { document.getElementById("out").textContent = "error:" + e.code; });
</script>`,
  "page2.html": `<!doctype html><p id="page">two</p>`,
};

test("a link inside a live-data artifact shows the notice; Reload reconnects", async ({
  page,
  member,
}) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Renav ${uniq()}`,
    entry: "index.html",
    files,
    capabilities: { db: true },
  });
  await page.goto(`/a/${id}`);
  const frame = artifactFrame(page);
  await expect(frame.locator("#out")).toHaveText("empty");
  const notice = page.getByText(COPY);
  await expect(notice).toBeHidden();

  await frame.locator("#next").click();
  await expect(frame.locator("#page")).toHaveText("two");
  await expect(notice).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: COPY }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Reload" }).click();
  // Back on the entry page with a fresh nonce: live data works again.
  await expect(frame.locator("#out")).toHaveText("empty");
  await expect(notice).toBeHidden();
});

test("a plain multi-page artifact never shows the notice", async ({
  page,
  member,
}) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Renav plain ${uniq()}`,
    entry: "index.html",
    files: {
      "index.html": `<!doctype html><a id="next" href="page2.html">Next</a>`,
      "page2.html": files["page2.html"],
    },
  });
  await page.goto(`/a/${id}`);
  const frame = artifactFrame(page);
  await frame.locator("#next").click();
  await expect(frame.locator("#page")).toHaveText("two");
  await page.waitForTimeout(500);
  await expect(page.getByText(COPY)).toBeHidden();
});
