import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const setup = read("../src/content/docs/setup.md");
const upgrade = read("../src/content/docs/upgrade.md");

describe("install runbook (#11-#14, #17)", () => {
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
  it("no em dashes in the runbook copy", () => {
    expect(setup + upgrade).not.toContain("—");
  });
});
