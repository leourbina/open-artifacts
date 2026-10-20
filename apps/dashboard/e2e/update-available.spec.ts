// "Update available" (Design's A + B): the sidebar chip and its popover, the
// Settings → Instance Version card, and who sees them.
import { expect, type Page, test } from "@playwright/test";

const COPIED = "Copied, paste this into your agent";
const chip = (page: Page) =>
  page.getByRole("button", { name: /^Update available/ });
const box = async (page: Page, sel: Parameters<Page["locator"]>[0]) => {
  const b = await page.locator(sel).boundingBox();
  if (!b) throw new Error(`no box for ${sel}`);
  return b;
};

test("admin: the chip opens the popover; Upgrade copies the prompt", async ({
  page,
  context,
  baseURL,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?mock=update");
  const c = chip(page);
  await expect(c).toHaveAttribute("aria-haspopup", "dialog");
  await expect(c).toHaveAttribute("aria-expanded", "false");
  await expect(c).toContainText("v0.15.0");
  await c.click();
  await expect(c).toHaveAttribute("aria-expanded", "true");
  const pop = page.getByRole("dialog", { name: "Update available" });
  await expect(pop).toContainText("v0.14.2");
  await expect(pop).toContainText("v0.15.0");
  await expect(pop.getByRole("status")).toBeEmpty();
  await pop.getByRole("button", { name: "Upgrade" }).click();
  await expect(pop.getByRole("status")).toHaveText(COPIED);
  const origin = new URL(baseURL ?? page.url()).origin;
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `Upgrade my Open Artifacts instance at ${origin}. Follow ${origin}/upgrade.md`,
  );
  await expect(
    pop.getByRole("link", { name: /Release notes/ }),
  ).toHaveAttribute("target", "_blank");
  // Esc closes it and puts focus back on the chip.
  await page.keyboard.press("Escape");
  await expect(pop).toBeHidden();
  await expect(c).toBeFocused();
  // Details in Settings goes to the Version card and closes the popover.
  await c.click();
  await pop.getByRole("link", { name: "Details in Settings" }).click();
  await expect(page).toHaveURL(/\/settings\/instance/);
  await expect(pop).toBeHidden();
  await expect(page.getByRole("region", { name: "Version" })).toBeVisible();
});

test("admin: the Version card copies the same prompt", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/settings/instance?mock=update");
  const card = page.getByRole("region", { name: "Version" });
  await expect(card).toContainText("Update available");
  await card.getByRole("button", { name: "Upgrade" }).click();
  await expect(card.getByRole("status")).toHaveText(COPIED);
  await expect(card.getByRole("status")).toBeEmpty({ timeout: 6000 });
});

test("admin up to date: no chip; the card says so", async ({ page }) => {
  await page.goto("/settings/instance?mock=uptodate");
  await expect(page.getByRole("region", { name: "Version" })).toContainText(
    "You're on the latest version",
  );
  await expect(chip(page)).toHaveCount(0);
});

test("member: no chip and no Version card", async ({ page }) => {
  await page.goto("/settings/agents?role=member&mock=update");
  await expect(page.getByRole("link", { name: "Agents" })).toBeVisible();
  await expect(chip(page)).toHaveCount(0);
  await page.goto("/?role=member&mock=update");
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  await expect(chip(page)).toHaveCount(0);
});

test("null update: nothing", async ({ page }) => {
  await page.goto("/settings/instance");
  await expect(page.getByLabel("Instance name")).toBeVisible();
  await expect(chip(page)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Version" })).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`geometry 1280 ${scheme}: chip pinned to the footer, popover 292px above it`, async ({
    page,
  }, info) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/?mock=update");
    const c = await box(
      page,
      "[aria-haspopup=dialog]:has-text('Update available')",
    );
    expect(c.height).toBe(32);
    expect(800 - (c.y + c.height)).toBeLessThan(24); // at the bottom of the sidebar
    await chip(page).click();
    const p = await box(page, "[data-slot=popover-content]");
    expect(p.width).toBe(292);
    expect(Math.round(c.y - (p.y + p.height))).toBe(8);
    expect(Math.round(p.x)).toBe(Math.round(c.x));
    await info.attach(`chip-open-1280-${scheme}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });

  test(`geometry 390 ${scheme}: dot on the menu trigger, chip in the drawer footer`, async ({
    page,
  }, info) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/?mock=update");
    const trigger = page.getByRole("button", {
      name: "Open menu, update available",
    });
    await expect(trigger).toBeVisible();
    await expect(chip(page)).toBeHidden(); // inside the closed drawer
    await trigger.click();
    // The sheet slides in from the left; measure once it has arrived.
    await expect
      .poll(async () => (await box(page, "[data-mobile=true]")).x)
      .toBe(0);
    const c = await box(
      page,
      "[aria-haspopup=dialog]:has-text('Update available')",
    );
    const sheet = await box(page, "[data-mobile=true]");
    expect(c.height).toBe(32);
    expect(c.x).toBeGreaterThanOrEqual(sheet.x);
    expect(c.x + c.width).toBeLessThanOrEqual(sheet.x + sheet.width);
    expect(sheet.y + sheet.height - (c.y + c.height)).toBeLessThan(24);
    await chip(page).click();
    const p = await box(page, "[data-slot=popover-content]");
    expect(Math.round(p.width)).toBe(Math.round(c.width));
    expect(p.x + p.width).toBeLessThanOrEqual(390);
    await info.attach(`chip-open-390-${scheme}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
}
