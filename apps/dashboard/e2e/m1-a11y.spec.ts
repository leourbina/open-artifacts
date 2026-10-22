import { createRequire } from "node:module";
import { expect, type Page, test } from "@playwright/test";

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});

const ROUTES = [
  "/",
  "/mine",
  "/shared",
  "/team",
  "/search?q=notes",
  "/a/Ef7hJkLmNp8qRsTv?panel=open&tab=versions",
  "/a/Cd5fGhJkLm6nPqRs/diff/1/2",
  "/no-access",
  "/sign-in",
  "/sign-in?hosted=1",
  "/sign-in?hosted=1&error=tenant",
  "/sign-in?hosted=1&method=code",
  "/nope",
  "/?mock=quota",
  "/?mock=cpu",
  "/?mock=cpu&role=member",
  "/settings/usage?mock=cpu",
];

const open = async (page: Page, path: string, theme: string, w: number) => {
  await page.setViewportSize({ width: w, height: 800 });
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await page.evaluate(
    (t) => document.documentElement.setAttribute("data-theme", t),
    theme,
  );
  await page.waitForTimeout(150);
};

/** Serious and critical axe violations on the current page. */
const axeViolations = async (page: Page) => {
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

for (const path of ROUTES)
  for (const theme of ["light", "dark"])
    for (const w of [1280, 390])
      test(`axe ${path} ${theme} ${w}`, async ({ page }) => {
        await open(page, path, theme, w);
        const v = await axeViolations(page);
        expect(v, v.join("\n")).toEqual([]);
      });

/** The code step the sign-in page shows after an emailed code request. */
const reachCodeStep = async (page: Page) => {
  await page.getByRole("textbox", { name: "Email" }).fill("bob@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByRole("textbox", { name: "Code", exact: true }).waitFor();
};

for (const theme of ["light", "dark"])
  for (const w of [1280, 390])
    test(`axe sign-in code step ${theme} ${w}`, async ({ page }) => {
      await open(page, "/sign-in?hosted=1&method=code", theme, w);
      await reachCodeStep(page);
      const v = await axeViolations(page);
      expect(v, v.join("\n")).toEqual([]);
    });

test("keyboard: sign in with an emailed code, no mouse", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/sign-in?hosted=1&method=code&next=%2Fshared");
  await page.waitForLoadState("networkidle");
  await page.getByRole("textbox", { name: "Email" }).focus();
  await page.keyboard.type("bob@example.com");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("textbox", { name: "Code", exact: true }),
  ).toBeFocused();
  await page.keyboard.type("24681357");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/shared$/);
});

for (const path of ROUTES)
  test(`no horizontal scroll at 390 ${path}`, async ({ page }) => {
    await open(page, path, "light", 390);
    const r = await page.evaluate(() => {
      const se = document.scrollingElement as Element;
      const wide = [...document.querySelectorAll("body *")]
        .filter((e) => e.getBoundingClientRect().right > innerWidth + 1)
        .filter(
          (e) =>
            !e.parentElement ||
            e.parentElement.getBoundingClientRect().right <= innerWidth + 1,
        )
        .map(
          (e) =>
            `${e.tagName.toLowerCase()}.${(e.getAttribute("class") ?? "").split(" ")[0]} right=${Math.round(e.getBoundingClientRect().right)}`,
        )
        .slice(0, 5);
      return { sw: se.scrollWidth, iw: innerWidth, wide };
    });
    expect(r.sw, `${r.sw} > ${r.iw}; ${r.wide.join(", ")}`).toBeLessThanOrEqual(
      r.iw,
    );
  });
