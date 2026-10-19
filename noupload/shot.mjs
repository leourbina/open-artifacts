import { chromium } from "/Users/leonardourbina/code/projects/openartifacts-fe-noupload/apps/dashboard/node_modules/@playwright/test/index.mjs";
const [,, phase] = process.argv;
const b = await chromium.launch();
for (const theme of ["light","dark"]) {
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto("http://localhost:5185/a/Cd5fGhJkLm6nPqRs");
  await p.waitForLoadState("networkidle");
  await p.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
  await p.waitForTimeout(800);
  await p.screenshot({ path: "/private/tmp/claude-501/-Users-leonardourbina-code-projects-openartifacts/ab874adb-764a-45d4-a4e9-b8a2f91173cc/scratchpad/shotsrepo/noupload/detail-"+theme+"-"+phase+".png" });
}
await b.close();
