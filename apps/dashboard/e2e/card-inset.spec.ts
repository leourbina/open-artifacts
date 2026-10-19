// Settings cards own their inset (#168): every child starts at the card's
// content edge and nothing pokes past it or scrolls the page sideways.
import { expect, type Page, test } from "@playwright/test";

/** Child boxes that don't line up with, or overflow, their card's content box. */
const misaligned = (page: Page) =>
  page.evaluate(() => {
    const bad: string[] = [];
    for (const card of document.querySelectorAll<HTMLElement>(".oa-card")) {
      const c = getComputedStyle(card);
      const r = card.getBoundingClientRect();
      const left =
        r.left + parseFloat(c.borderLeftWidth) + parseFloat(c.paddingLeft);
      const right =
        r.right - parseFloat(c.borderRightWidth) - parseFloat(c.paddingRight);
      for (const child of card.children) {
        const b = child.getBoundingClientRect();
        if (b.width === 0) continue; // dialogs portal out; empty nodes
        const name = `${card.getAttribute("aria-labelledby")} > ${child.tagName}.${child.className}`;
        if (Math.abs(b.left - left) > 0.5)
          bad.push(`${name} left ${b.left} != ${left}`);
        if (b.right > right + 0.5)
          bad.push(`${name} right ${b.right} > ${right}`);
      }
      for (const el of card.querySelectorAll("*")) {
        // Content of a scroller (tab strip, code block) is clipped, not overflowing.
        let scrolled = false;
        for (let p = el.parentElement; p && p !== card; p = p.parentElement)
          if (getComputedStyle(p).overflowX !== "visible") scrolled = true;
        if (scrolled) continue;
        const b = el.getBoundingClientRect();
        if (b.width && b.right > r.right + 0.5)
          bad.push(`${el.tagName} past card edge`);
      }
    }
    return bad;
  });

const sideScroll = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );

for (const width of [1280, 390]) {
  test(`Agents cards inset their content at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings/agents");
    await expect(
      page.getByRole("radiogroup", { name: "Auth method" }),
    ).toBeVisible();
    expect(await misaligned(page)).toEqual([]);
    expect(await sideScroll(page)).toBe(0);

    // Copy URL shares the input's row.
    const input = await page
      .getByRole("textbox", { name: "MCP server URL" })
      .boundingBox();
    const copy = await page
      .getByRole("button", { name: "Copy URL" })
      .boundingBox();
    expect(Math.abs((copy?.y ?? 0) - (input?.y ?? 0))).toBeLessThan(4);

    // The snippet's Copy button sits beside the code, not over it.
    const pre = await page.locator(".oa-code pre").first().boundingBox();
    const btn = await page
      .getByRole("button", { name: "Copy command" })
      .boundingBox();
    expect((btn?.x ?? 0) >= (pre?.x ?? 0) + (pre?.width ?? 0)).toBe(true);

    // Empty states line up too.
    for (const name of ["Example MCP client", "laptop"]) {
      await page.getByRole("button", { name: `Revoke ${name}` }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Revoke" })
        .click();
    }
    await expect(
      page.getByText("No agents connected yet.", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("No tokens.", { exact: false })).toBeVisible();
    expect(await misaligned(page)).toEqual([]);
  });

  test(`token-created dialog keeps code and Copy inside at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings/agents");
    await page.getByRole("button", { name: "Create token" }).click();
    await page.getByRole("textbox", { name: "Label" }).fill("ci");
    await page.getByRole("button", { name: "Create" }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("button", { name: "Copy token" }),
    ).toBeVisible();
    const out = await dialog.evaluate((d) => {
      const r = d.getBoundingClientRect();
      return [...d.querySelectorAll(".oa-code, .oa-code button")]
        .map((el) => el.getBoundingClientRect())
        .filter(
          (b) => b.width && (b.right > r.right + 0.5 || b.left < r.left - 0.5),
        ).length;
    });
    expect(out).toBe(0);
    expect(await sideScroll(page)).toBe(0);
  });
}

test("Members and Instance cards inset their content at 390px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  for (const path of ["/settings/members", "/settings/instance"]) {
    await page.goto(path);
    await expect(page.locator(".oa-card").first()).toBeVisible();
    expect(await misaligned(page)).toEqual([]);
    expect(await sideScroll(page)).toBe(0);
  }
});
