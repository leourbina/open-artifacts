// Settings → Agents cards own their inset: every child starts at the card's
// content edge (Design: --oa-space-5, --oa-space-4 at <= 600px), nothing
// pokes past it, and the page never scrolls sideways.
import { expect, type Page, test } from "@playwright/test";

const inset = (width: number) =>
  width <= 600 ? "--oa-space-4" : "--oa-space-5";

/** Inset children whose left edge isn't the card's content edge, or that
    overflow the card. */
const misaligned = (page: Page, token: string) =>
  page.evaluate((token) => {
    const bad: string[] = [];
    const want = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(token),
    );
    const inset = [
      "[data-slot=card-header] > :first-child",
      "[data-slot=card-content] > *",
      "[data-slot=tabs-list]",
      "[data-slot=tabs-content]:not([hidden]) > *",
      "li > b",
    ].join(",");
    for (const card of document.querySelectorAll<HTMLElement>(
      ".oa-stack [data-slot=card]",
    )) {
      const r = card.getBoundingClientRect();
      const border = parseFloat(getComputedStyle(card).borderLeftWidth);
      const left = r.left + border + want;
      const right = r.right - border - want;
      for (const el of card.querySelectorAll(inset)) {
        const b = el.getBoundingClientRect();
        if (!b.width) continue;
        const name = `${card.textContent?.slice(0, 20)} ${el.tagName}.${el.getAttribute("data-slot") ?? el.className}`;
        if (Math.abs(b.left - left) > 0.5)
          bad.push(`${name} left ${b.left} != ${left}`);
        if (b.right > right + 0.5)
          bad.push(`${name} right ${b.right} > ${right}`);
      }
      // Header and content own the padding, so only what they hold counts.
      for (const el of card.querySelectorAll(
        "[data-slot=card-header] *, [data-slot=card-content] *",
      )) {
        // Content of a scroller (tab strip, code block) is clipped, not overflowing.
        let scrolled = false;
        for (let p = el.parentElement; p && p !== card; p = p.parentElement)
          if (getComputedStyle(p).overflowX !== "visible") scrolled = true;
        const b = el.getBoundingClientRect();
        if (!scrolled && b.width && b.right > right + 0.5)
          bad.push(`${el.tagName} past the card's content edge`);
      }
    }
    return bad;
  }, token);

const sideScroll = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );

for (const width of [1280, 390]) {
  test(`Agents cards inset every child at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings/agents");
    await expect(page.getByRole("radio", { name: "OAuth" })).toBeVisible();
    expect(await misaligned(page, inset(width))).toEqual([]);
    expect(await sideScroll(page)).toBe(0);

    // Copy URL shares the input's row.
    const input = await page
      .getByRole("textbox", { name: "MCP server URL" })
      .boundingBox();
    const copy = await page
      .getByRole("button", { name: "Copy URL" })
      .boundingBox();
    expect(input && copy).toBeTruthy();
    if (input && copy) {
      expect(
        Math.abs(copy.y + copy.height / 2 - (input.y + input.height / 2)),
      ).toBeLessThan(1);
      expect(copy.x).toBeGreaterThan(input.x + input.width);
    }

    // The snippet's Copy button sits beside the code, not over it.
    const pre = await page.locator("pre").first().boundingBox();
    const btn = await page
      .getByRole("button", { name: "Copy command" })
      .boundingBox();
    expect((btn?.x ?? 0) >= (pre?.x ?? 0) + (pre?.width ?? 0)).toBe(true);

    // The token variant and the empty states line up too.
    await page.getByRole("radio", { name: "Token" }).click();
    expect(await misaligned(page, inset(width))).toEqual([]);
    for (const name of ["Example MCP client", "laptop"]) {
      await page.getByRole("button", { name: `Revoke ${name}` }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Revoke" })
        .click();
    }
    await expect(page.getByText(/No agents connected yet/)).toBeVisible();
    await expect(page.getByText(/^No tokens/)).toBeVisible();
    expect(await misaligned(page, inset(width))).toEqual([]);
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
      return [
        ...d.querySelectorAll('pre, code.block, button[aria-label^="Copy"]'),
      ]
        .map((el) => el.getBoundingClientRect())
        .filter(
          (b) => b.width && (b.right > r.right + 0.5 || b.left < r.left - 0.5),
        ).length;
    });
    expect(out).toBe(0);
    expect(await sideScroll(page)).toBe(0);
  });

  test(`other settings pages don't scroll sideways at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [
      "/settings/profile",
      "/settings/members",
      "/settings/instance",
      "/settings/usage",
    ]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await sideScroll(page), path).toBe(0);
    }
  });
}

test("stacked rows at 390px: name on its own line, meta left, action right", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/settings/agents");
  const row = await page.locator("li", { hasText: "laptop" }).evaluate((li) => {
    const box = (el: Element | null) => el?.getBoundingClientRect();
    const name = li.querySelector("b");
    const n = box(name);
    const meta = box(li.querySelector("span"));
    const btn = box(li.querySelector("button"));
    return {
      nowrap: name ? getComputedStyle(name).whiteSpace : "",
      ellipsis: name ? getComputedStyle(name).textOverflow : "",
      gap: Math.round((meta?.top ?? 0) - (n?.bottom ?? 0)),
      sameLine:
        Math.abs(
          (btn?.top ?? 0) +
            (btn?.height ?? 0) / 2 -
            ((meta?.top ?? 0) + (meta?.height ?? 0) / 2),
        ) < 1,
      flushRight:
        Math.abs((btn?.right ?? 0) - li.getBoundingClientRect().right) < 0.5,
    };
  });
  expect(row).toMatchObject({
    nowrap: "nowrap",
    ellipsis: "ellipsis",
    sameLine: true,
    flushRight: true,
  });
  expect(row.gap).toBeGreaterThanOrEqual(8);
});
