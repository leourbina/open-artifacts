import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const setup = read("../src/content/docs/setup.md");
const upgrade = read("../src/content/docs/upgrade.md");
const llms = read("../src/lib/llms.ts");
const index = read("../src/pages/index.astro");

describe("install runbook (#11-#14, #17, prompt phrase)", () => {
  it("#11: whoami first, with a long timeout, skipping the login when accounts exist", () => {
    expect(setup).toContain(
      "First run `npx wrangler whoami --json` with at least a 3-minute timeout (it can refresh a login). If it lists accounts, skip the login.",
    );
  });
  it("#12: team asks about Workers Paid together and warns about the Access token and mail domain", () => {
    expect(setup).toMatch(
      /ask in the same message whether the account is on Workers Paid/,
    );
    expect(setup).toMatch(
      /create an Access token and onboard the sending domain `mail\.<app-host>`/,
    );
  });
  it("#13: one hostname proposes the content host and owner email", () => {
    expect(setup).toContain("`<first-label>-content.<zone>`");
    expect(setup).toMatch(
      /email from `wrangler whoami` as `--owner-email`, and confirm both/,
    );
  });
  it("#14: clone outside any repo into ~/open-artifacts; upgrades run from there", () => {
    expect(setup).toContain(
      "Clone outside any existing git repository, e.g. `~/open-artifacts`, and tell the user where; upgrades run from there.",
    );
    expect(setup).toContain('"$REPO" ~/open-artifacts');
    expect(upgrade).toContain("~/open-artifacts");
  });
  it("#17: the ignored build scripts message is documented as expected", () => {
    expect(setup).toContain("Ignored build scripts: esbuild, workerd");
  });
  it("the prompt phrase is the same everywhere, and llms.txt tells agents what a hostname means", () => {
    const phrase =
      "Install Open Artifacts on <host> using open-artifacts.com/llms.txt";
    expect(setup).toContain(`> ${phrase}`);
    expect(index).toContain(phrase);
    expect(setup + index + llms).not.toMatch(/[Ss]et up open-artifacts\.com/);
    expect(llms).toContain(
      "If the user asked you to set up this file, optionally 'at', 'on' or 'under' a hostname, they want you to install Open Artifacts with that hostname as --app-host. Don't copy or host this file.",
    );
  });
  it("no em dashes in the runbook copy", () => {
    expect(setup + upgrade + llms + index).not.toContain("—");
  });
});
