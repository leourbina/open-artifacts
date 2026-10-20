import {
  APP,
  artifactFrame,
  expect,
  publishViaApi,
  test,
  uniq,
} from "./fixtures";

// An anonymous vote: viewer.get() gives { anonId } and the vote's updatedBy is
// "anon:<anonId>", the same before and after a reload (one browser, one id).
const VOTE_PAGE = `<!doctype html>
<p id="me">loading</p><p id="by">none</p><button id="vote">Vote</button>
<script>
const oa = window.openArtifacts;
const votes = () => oa.db.collection("votes");
oa.ready
  .then(() => oa.viewer.get())
  .then((v) => { document.getElementById("me").textContent = v && v.anonId ? v.anonId : "none"; })
  .catch((e) => { document.getElementById("me").textContent = "error:" + e.message; });
document.getElementById("vote").onclick = () =>
  votes().set("v-" + Math.random().toString(36).slice(2), { option: "Tabs" })
    .then((d) => { document.getElementById("by").textContent = d.updatedBy; })
    .catch((e) => { document.getElementById("by").textContent = "error:" + e.message; });
</script>`;

test("an anonymous vote keeps the same anonId across a reload", async ({
  browser,
  member,
}) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Anon vote ${uniq()}`,
    format: "html",
    content: VOTE_PAGE,
    visibility: "public",
    allowAnonymousWrites: true,
    capabilities: { db: true, viewer: true },
  });
  const anon = await browser.newContext({ baseURL: APP });
  const page = await anon.newPage();
  await page.goto(`/a/${id}`);
  const f = artifactFrame(page);
  await expect(f.locator("#me")).toHaveText(/^[A-Za-z0-9_-]{8}$/);
  const me = (await f.locator("#me").textContent()) ?? "";
  await f.getByRole("button", { name: "Vote" }).click();
  await expect(f.locator("#by")).toHaveText(`anon:${me}`);

  await page.reload();
  await expect(f.locator("#me")).toHaveText(me);
  await f.getByRole("button", { name: "Vote" }).click();
  await expect(f.locator("#by")).toHaveText(`anon:${me}`);

  // Another browser is someone else.
  const other = await browser.newContext({ baseURL: APP });
  const p2 = await other.newPage();
  await p2.goto(`/a/${id}`);
  const f2 = artifactFrame(p2);
  await expect(f2.locator("#me")).toHaveText(/^[A-Za-z0-9_-]{8}$/);
  expect(await f2.locator("#me").textContent()).not.toBe(me);
  await anon.close();
  await other.close();
});
