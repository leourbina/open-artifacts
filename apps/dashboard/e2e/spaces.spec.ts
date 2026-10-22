// Hosted P4 Tasks 10 and 11: /settings/spaces (D5 as drawn) at 1280 and 390,
// light and dark: the list with Every space and the Access switch, one space
// (Engineering) and the admin's no-role view (Clients); axe, no sideways
// scroll, keyboard.
import { createRequire } from "node:module";
import { expect, type Page, test } from "@playwright/test";

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});
const axeRun = async (page: Page): Promise<string[]> => {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    // @ts-expect-error injected
    const r = await axe.run(document, { resultTypes: ["violations"] });
    return r.violations
      .filter(
        (x: { impact: string }) =>
          x.impact === "serious" || x.impact === "critical",
      )
      .map(
        (x: { id: string; impact: string; nodes: { target: string[] }[] }) =>
          `${x.impact} ${x.id}: ${x.nodes
            .map((n) => n.target.join(" "))
            .slice(0, 4)
            .join(" | ")}`,
      );
  });
};
const noOverflow = async (page: Page) => {
  const over = await page.evaluate(
    () => (document.scrollingElement?.scrollWidth ?? 0) - innerWidth,
  );
  expect(over, "horizontal overflow px").toBeLessThanOrEqual(0);
};
const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );

const VIEWS: [string, string, string][] = [
  ["list", "/settings/spaces?hosted=1", "Spaces"],
  [
    "engineering",
    "/settings/spaces?hosted=1&space=SpEngNpQrSt2uVwX",
    "Engineering",
  ],
  ["clients", "/settings/spaces?hosted=1&space=SpCliNpQrSt4uVwX", "Clients"],
  [
    "frozen",
    "/settings/spaces?hosted=frozen&space=SpEngNpQrSt2uVwX",
    "Engineering",
  ],
];

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 } });
      for (const [name, url, heading] of VIEWS)
        test(`${name}: axe, no sideways scroll`, async ({ page }, info) => {
          await page.goto(url);
          await page.waitForLoadState("networkidle");
          await page.getByRole("heading", { name: heading }).first().waitFor();
          const v = await axeRun(page);
          expect(v, v.join("\n")).toEqual([]);
          await noOverflow(page);
          await page.screenshot({
            path: info.outputPath(`spaces-${name}-${scheme}-${width}.png`),
            fullPage: true,
          });
        });
    });

test("dialogs pass axe: New space, Add me, public links off", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings/spaces?hosted=1");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "New space" }).click();
  await expect(page.getByRole("dialog", { name: "New space" })).toBeVisible();
  await settle(page);
  let v = await axeRun(page);
  expect(v, v.join("\n")).toEqual([]);
  await page.keyboard.press("Escape");
  await page.goto("/settings/spaces?hosted=1&space=SpCliNpQrSt4uVwX");
  await page.getByRole("button", { name: "Add me to this space" }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Add yourself to Clients?",
  );
  await settle(page);
  v = await axeRun(page);
  expect(v, v.join("\n")).toEqual([]);
  await page.keyboard.press("Escape");
  await page.getByRole("switch", { name: "Public links" }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "become visible to the team only",
  );
  await settle(page);
  v = await axeRun(page);
  expect(v, v.join("\n")).toEqual([]);
});

test("keyboard: open a space from the list, add a group, change its role", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings/spaces?hosted=1");
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: /Engineering/ }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { level: 2, name: "Engineering" }).waitFor();
  const box = page.getByRole("combobox", { name: "Add a group" });
  await box.focus();
  await page.keyboard.type("sa");
  await page.getByRole("option", { name: /sales@example.com/ }).waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const sales = page.getByRole("row", { name: /sales@example.com/ });
  await expect(sales).toBeVisible();
  const role = sales.getByRole("combobox", {
    name: "Role for sales@example.com",
  });
  await role.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("option", { name: "Editor" }).focus();
  await page.keyboard.press("Enter");
  await expect(role).toHaveText("Editor");
});
