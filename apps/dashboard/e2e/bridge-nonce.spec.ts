// The shell signs a frame's src with a nonce and hears only messages that carry
// it, from that frame's own window. A frame that navigates itself (a link) is a
// new document that never read the nonce; the bridge is disposed on that second
// load, so even a message signed with the old nonce gets no answer.
import { expect, test } from "@playwright/test";

const DOC = `<!doctype html><body id="b">starting
<script>
const q = new URLSearchParams(location.search);
const nonce = q.get("old") ?? new URLSearchParams(location.hash.slice(1)).get("oa");
let welcomes = 0;
addEventListener("message", (e) => {
  if (e.data && e.data.type === "welcome") {
    welcomes++;
    document.getElementById("b").textContent = "welcome:" + welcomes;
    const a = document.createElement("a");
    a.id = "go";
    a.textContent = "go";
    a.href = "?second=1&old=" + nonce;
    document.body.append(a);
  }
});
const hello = () =>
  parent.postMessage({ oa: 1, type: "hello", protocol: 1, kind: "html", nonce }, "*");
if (!q.has("second")) hello();
else
  // The new document says hello with the old nonce once it has loaded (a hello
  // sent while parsing can beat the shell's load event), then reports the replies.
  addEventListener("load", () => {
    setTimeout(hello, 100);
    setTimeout(() => {
      document.getElementById("b").textContent = "second:" + welcomes;
    }, 700);
  });
</script>`;

test("a renavigated frame cannot reach the bridge, even with the old nonce", async ({
  page,
}) => {
  await page.route("https://content.example.com/**", (r) =>
    r.fulfill({ contentType: "text/html", body: DOC }),
  );
  await page.goto("/a/Ef7hJkLmNp8qRsTv");
  const src = await page.locator("iframe.oa-vframe").getAttribute("src");
  expect(src).toMatch(/#oa=[A-Za-z0-9_-]{22}$/);
  const doc = page.frameLocator("iframe.oa-vframe");
  // The first document is signed with the nonce in its src and is welcomed.
  await expect(doc.locator("#b")).toContainText("welcome:1");
  await doc.locator("#go").click();
  await expect(doc.locator("#b")).toHaveText("second:0");
});
