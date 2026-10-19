// Captures the landing screenshots in public/shots from the design mockups in
// design/screens, light and dark, at 800, 1280 and 2560 wide (webp).
// Patches applied before capture, so the shots match the landing's copy rules:
// real miniature thumbnails (no gray placeholder bars), no em dashes, agent
// names that never truncate, and no mockup controls.
// Usage: node apps/landing/scripts/shots.mjs [library|artifact ...]
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const screens = resolve(here, "../../../design/screens");
const out = resolve(here, "../public/shots");
const SHOTS = { library: "library.html", artifact: "artifact-view.html" };

const CSS = `
.dev { display: none !important; }
.card .sub { flex-wrap: wrap; row-gap: 4px; }
.card .agent { overflow: visible; text-overflow: clip; }
.mini { font: 400 7.5px/1.45 var(--oa-font-sans); color: var(--oa-text-2); }
.mini b { display: block; color: var(--oa-text); font-size: 9.5px; font-weight: 600; margin-bottom: 4px; }
.mini h6 { margin: 6px 0 2px; color: var(--oa-text); font-size: 8px; font-weight: 600; }
.mini p { margin: 0 0 3px; }
.mini table { width: 100%; border-collapse: collapse; margin-top: 3px; }
.mini td { padding: 1.5px 0; border-top: 1px solid var(--oa-divider); }
.mini td:last-child { text-align: right; }
.mini .ok { color: var(--oa-success-fg); } .mini .go { color: var(--oa-accent-fg); } .mini .warn { color: var(--oa-warning); }
.mini.redl b { padding-right: 46px; }
.mini del { color: var(--oa-danger); } .mini ins { color: var(--oa-success-fg); text-decoration: none; }
.mini .bars { display: flex; align-items: flex-end; gap: 4px; height: 54px; margin-top: 6px; border-bottom: 1px solid var(--oa-divider); }
.mini .bars i { flex: 1; position: relative; background: var(--oa-accent); opacity: .55; border-radius: 2px 2px 0 0; }
.mini .bars i.hi { opacity: 1; }
.mini .bars i span { position: absolute; top: -10px; left: 0; right: 0; text-align: center; font-style: normal; font-size: 6.5px; color: var(--oa-text-muted); }
.mini .axis { display: flex; gap: 4px; font-size: 6.5px; color: var(--oa-text-muted); }
.mini .axis span { flex: 1; text-align: center; }
.mini.deck { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.mini.deck .sl { aspect-ratio: 16 / 9; padding: 5px 6px; background: var(--oa-surface); box-shadow: 0 0 0 1px var(--oa-divider); border-radius: 3px; font-size: 6.5px; overflow: hidden; }
.mini.deck .sl b { font-size: 7.5px; margin-bottom: 2px; }
.mini.deck .big { color: var(--oa-accent-fg); font-size: 11px; font-weight: 600; }
`;

const THUMBS = {
  "Q4 data migration plan": `<div class="pg mini"><b>Q4 data migration plan</b>
    <p>Move orders and billing to the new cluster with under 5 minutes of write downtime.</p>
    <h6>Phases</h6><table>
    <tr><td>Catalog dry run</td><td class="ok">Done</td></tr>
    <tr><td>Replicate orders</td><td class="go">In progress</td></tr>
    <tr><td>Billing cutover</td><td class="warn">At risk</td></tr></table></div>`,
  "Vendor MSA: redlined.pdf": `<div class="pg mini redl" style="margin:0 18px"><b>Master Services Agreement</b>
    <p>4.2 Fees are billed <del>quarterly</del> <ins>monthly</ins> in arrears.</p>
    <p>7.1 Either party may end this agreement with <del>90</del> <ins>30</ins> days' notice.</p>
    <p>9.3 Liability is capped at fees paid in the prior 12 months.</p><span class="stamp">REDLINE</span></div>`,
  "Churn by signup cohort": `<div class="pg mini"><b>Churn by signup cohort</b><p>Share of signups gone after 90 days</p>
    <div class="bars">${[38, 52, 47, 61, 70, 58, 82, 76]
      .map((h, i) => `<i class="${i === 6 ? "hi" : ""}" style="height:${h}%"><span>${Math.round(h / 4)}%</span></i>`)
      .join("")}</div>
    <div class="axis">${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug"].map((m) => `<span>${m}</span>`).join("")}</div></div>`,
  "Billing webhook retries: postmortem": `<div class="pg mini"><b>Billing webhook retries</b>
    <h6>Summary</h6><p>A retry loop sent 3,100 duplicate invoice events over 40 minutes. No customer was charged twice.</p>
    <h6>Timeline</h6><p>14:02 retries spike. 14:19 queue paused. 14:42 fix shipped.</p></div>`,
  "Platform all-hands, October": `<div class="pg mini deck">
    <div class="sl"><b>Platform all-hands</b>October</div>
    <div class="sl"><b>Shipped</b>Team sharing, version restore</div>
    <div class="sl"><b>p95 latency</b><span class="big">142 ms</span></div>
    <div class="sl"><b>Next</b>Self-serve SSO, audit log</div></div>`,
};

async function patch(page) {
  await page.addStyleTag({ content: CSS });
  await page.evaluate((thumbs) => {
    // No em dashes in user-visible text.
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode())
      if (n.nodeValue.includes("—"))
        n.nodeValue = n.nodeValue.replace(/\s*—\s*/g, ": ");
    // Short dates keep each card's meta on one line next to the agent name.
    for (const w of document.querySelectorAll(".card .when"))
      if (w.textContent === "Yesterday") w.textContent = "1d ago";
    for (const card of document.querySelectorAll(".card")) {
      const title = card.querySelector(".ttl span")?.textContent ?? "";
      const thumb = card.querySelector(".thumb");
      if (thumb && thumbs[title]) thumb.innerHTML = thumbs[title];
    }
  }, THUMBS);
}

const browser = await chromium.launch();
const tmp = mkdtempSync(join(tmpdir(), "oa-shots-"));
try {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SHOTS);
  for (const name of names)
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 2,
        colorScheme: theme,
      });
      const url = pathToFileURL(join(screens, SHOTS[name]));
      url.search = `theme=${theme}`;
      await page.goto(url.href, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      await patch(page);
      const png = join(tmp, `${name}-${theme}.png`);
      await page.screenshot({ path: png });
      await page.close();
      for (const w of [800, 1280, 2560])
        execFileSync("cwebp", ["-quiet", "-q", "82", "-resize", String(w), "0", png, "-o", join(out, `${name}-${theme}-${w}.webp`)]);
      console.log(`${name}-${theme}`);
    }
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
