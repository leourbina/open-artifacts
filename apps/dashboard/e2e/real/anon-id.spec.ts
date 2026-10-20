import type { FrameLocator, Page } from "@playwright/test";
import {
  APP,
  artifactFrame,
  expect,
  publishViaApi,
  test,
  uniq,
} from "./fixtures";

// An anonymous vote: viewer.get() stays null, viewer.anonId() gives the id,
// and the vote's updatedBy is "anon:<anonId>", the same before and after a
// reload (one browser, one id).
const VOTE_PAGE = `<!doctype html>
<p id="me">loading</p><p id="by">none</p><button id="vote">Vote</button>
<script>
const oa = window.openArtifacts;
const votes = () => oa.db.collection("votes");
const by = document.getElementById("by");
oa.ready
  .then(() => Promise.all([oa.viewer.get(), oa.viewer.anonId()]))
  .then(([v, id]) => { document.getElementById("me").textContent = v === null && id ? id : "bad:" + JSON.stringify([v, id]); })
  .catch((e) => { document.getElementById("me").textContent = "error:" + e.message; });
document.getElementById("vote").onclick = () => {
  by.textContent = "pending";
  votes().set("v-" + Math.random().toString(36).slice(2), { option: "Tabs" })
    .then((d) => { by.textContent = d.updatedBy; })
    .catch((e) => { by.textContent = "error:" + e.message; });
};
</script>`;

const ID_RE = /^[A-Za-z0-9_-]{8}$/;
/** Other specs (agent-journey step 5) exhaust this IP's anonymous budget. */
const LIMITED = /too many|rate.?limit/i;
/** Up to two minute-aligned limiter windows, plus slack. */
const RETRY_MS = 125_000;

/** Sleeps to just past the next minute boundary (the limiter's window). */
const nextWindow = (deadline: number) =>
  new Promise((r) =>
    setTimeout(
      r,
      Math.max(
        0,
        Math.min(60_000 - (Date.now() % 60_000) + 1_000, deadline - Date.now()),
      ),
    ),
  );

/** Loads `path` until #me shows an id, retrying while rate limited. */
async function loadMe(page: Page, path: string): Promise<string> {
  const f = artifactFrame(page);
  const deadline = Date.now() + RETRY_MS;
  for (;;) {
    await page.goto(path);
    const me = f.locator("#me");
    await expect(me).not.toHaveText("loading");
    const text = (await me.textContent()) ?? "";
    if (!LIMITED.test(text) || Date.now() > deadline) {
      expect(text).toMatch(ID_RE);
      return text;
    }
    await nextWindow(deadline);
  }
}

/** Votes until a write lands (retrying while rate limited); returns updatedBy. */
async function vote(f: FrameLocator): Promise<string> {
  const by = f.locator("#by");
  const deadline = Date.now() + RETRY_MS;
  for (;;) {
    await f.getByRole("button", { name: "Vote" }).click();
    await expect(by).not.toHaveText(/^(none|pending)$/);
    const text = (await by.textContent()) ?? "";
    if (!LIMITED.test(text) || Date.now() > deadline) return text;
    await nextWindow(deadline);
  }
}

test("an anonymous vote keeps the same anonId across a reload", async ({
  browser,
  member,
}) => {
  // Each step may wait out up to two limiter windows.
  test.setTimeout(5 * RETRY_MS + 60_000);
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
  const f = artifactFrame(page);
  const me = await loadMe(page, `/a/${id}`);
  expect(await vote(f)).toBe(`anon:${me}`);

  expect(await loadMe(page, `/a/${id}`)).toBe(me);
  expect(await vote(f)).toBe(`anon:${me}`);

  // Another browser is someone else.
  const other = await browser.newContext({ baseURL: APP });
  const p2 = await other.newPage();
  expect(await loadMe(p2, `/a/${id}`)).not.toBe(me);
  await anon.close();
  await other.close();
});
