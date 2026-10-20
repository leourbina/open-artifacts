import { R } from "@oa/shared";
import {
  APP,
  artifactFrame,
  expect,
  publishViaApi,
  test,
  uniq,
} from "./fixtures";

// A page the artifact frame is renavigated to (by an embedder, or anything else
// that can navigate it). Its origin is "null" and its window is the frame's, so
// only the per-load nonce tells it apart from the artifact.
const ATTACKER = "https://attacker.e2e.invalid/";
const ATTACKER_PAGE = `<!doctype html>
<p id="out">waiting</p>
<script>
const out = document.getElementById("out");
addEventListener("message", (e) => {
  out.textContent = "reply:" + JSON.stringify(e.data);
});
const call = (id, nonce) =>
  parent.postMessage(
    Object.assign(
      { oa: 1, type: "call", id, method: "db.set",
        params: { collection: "notes", id: "pwn", data: { x: 1 } } },
      nonce === undefined ? {} : { nonce },
    ),
    "*",
  );
parent.postMessage({ oa: 1, type: "hello", protocol: 1, kind: "html" }, "*");
parent.postMessage(
  { oa: 1, type: "hello", protocol: 1, kind: "html", nonce: "AAAAAAAAAAAAAAAAAAAAAA" },
  "*",
);
call("none");
call("guess", "AAAAAAAAAAAAAAAAAAAAAA");
call("hash", location.hash.slice(4));
setTimeout(() => {
  if (out.textContent === "waiting") out.textContent = "no reply";
}, 3000);
</script>`;

const DB_PAGE = `<!doctype html>
<p id="out">loading</p>
<script>
window.openArtifacts.ready
  .then(() => window.openArtifacts.db.collection("notes").get("n1"))
  .then((d) => { document.getElementById("out").textContent = d ? "doc" : "empty"; })
  .catch((e) => { document.getElementById("out").textContent = "error:" + e.code; });
</script>`;

test("a renavigated artifact frame can't call the bridge", async ({
  page,
  member,
}) => {
  await page.route(`${ATTACKER}**`, (r) =>
    r.fulfill({ contentType: "text/html", body: ATTACKER_PAGE }),
  );
  const { id } = await publishViaApi(member.pat, {
    title: `Nonce ${uniq()}`,
    format: "html",
    content: DB_PAGE,
    capabilities: { db: true },
  });
  await page.goto(`/a/${id}`);
  // The real artifact talks to the bridge (its nonce came in the frame URL)...
  await expect(artifactFrame(page).locator("#out")).toHaveText("empty");
  const el = page.locator("iframe.oa-vframe");
  // ...and the runtime stripped the nonce from the artifact's own URL.
  const frame = await (await el.elementHandle())?.contentFrame();
  if (!frame) throw new Error("no artifact frame");
  expect(new URL(frame.url()).hash).toBe("");

  // Renavigate the frame to a page that never saw the nonce.
  await frame.goto(ATTACKER);
  const out = artifactFrame(page).locator("#out");
  await expect(out).toHaveText("no reply", { timeout: 10_000 });

  // Nothing was written with the viewer's session.
  const res = await page.request.get(`${APP}${R.dataDoc(id, "notes", "pwn")}`);
  expect(res.status()).toBe(404);
});

test("a reload hands the frame a fresh nonce and the artifact keeps working", async ({
  page,
  member,
}) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Nonce reload ${uniq()}`,
    format: "html",
    content: DB_PAGE,
    capabilities: { db: true },
  });
  await page.goto(`/a/${id}`);
  const el = page.locator("iframe.oa-vframe");
  await expect(artifactFrame(page).locator("#out")).toHaveText("empty");
  const first = await el.getAttribute("src");
  expect(first).toMatch(/#oa=[A-Za-z0-9_-]{22}$/);
  await page.reload();
  await expect(artifactFrame(page).locator("#out")).toHaveText("empty");
  const second = await el.getAttribute("src");
  expect(second).toMatch(/#oa=[A-Za-z0-9_-]{22}$/);
  expect(second?.slice(-22)).not.toBe(first?.slice(-22));
});
