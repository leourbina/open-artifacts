import { R } from "@oa/shared";
import {
  APP,
  artifactFrame,
  expect,
  publishViaApi,
  test,
  uniq,
} from "./fixtures";

// Live version updates against the real server: the R.events socket tells
// an open viewer about a new version in about 2 s. Untouched, it swaps in
// (option B); touched, the chip.
const page1 = (n: number) =>
  `<!doctype html><h1 id="v">version ${n}</h1><input id="note" aria-label="Note">`;

const publishVersion = (pat: string, id: string, n: number) =>
  fetch(`${APP}${R.versions(id)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${pat}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ id, format: "html", content: page1(n) }),
  }).then((r) => {
    expect(r.ok).toBe(true);
  });

test("publish v2 while v1 is open: it swaps in within about 2 s", async ({
  page,
  member,
}) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Live ${uniq()}`,
    format: "html",
    content: page1(1),
  });
  await page.goto(`/a/${id}`);
  await expect(artifactFrame(page).locator("#v")).toHaveText("version 1");
  // The events socket's hello has landed.
  await page.waitForTimeout(500);
  await publishVersion(member.pat, id, 2);
  const t0 = Date.now();
  await expect(page.getByText("Updated to v2")).toBeVisible({ timeout: 3_000 });
  expect(Date.now() - t0).toBeLessThan(3_000);
  await expect(page.locator("iframe.oa-vframe")).toHaveCount(1);
  await expect(artifactFrame(page).locator("#v")).toHaveText("version 2");
  await expect(
    page.getByRole("button", { name: "Version: v2 · Current" }),
  ).toBeVisible();
});

test("touched (typed in the frame): the chip, and the typing survives", async ({
  page,
  member,
}) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Live ${uniq()}`,
    format: "html",
    content: page1(1),
  });
  await page.goto(`/a/${id}/full`);
  const frame = artifactFrame(page);
  await expect(frame.locator("#v")).toHaveText("version 1");
  await frame.locator("#note").fill("half typed");
  await page.waitForTimeout(500);
  await publishVersion(member.pat, id, 2);
  await expect(
    page.getByRole("button", { name: "View version 2" }),
  ).toBeVisible({ timeout: 3_000 });
  await expect(frame.locator("#note")).toHaveValue("half typed");
  await page.getByRole("button", { name: "View version 2" }).click();
  await expect(page.locator("iframe.oa-vframe")).toHaveCount(1);
  await expect(artifactFrame(page).locator("#v")).toHaveText("version 2");
});
