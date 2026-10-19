import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// llms.txt's setup steps must follow scripts/setup's plan, team and email
// behavior: relay warnings verbatim, ask solo or team, handle the email step.
const llms = readFileSync(
  fileURLToPath(new URL("../dist/llms.txt", import.meta.url)),
  "utf8",
);
const setup =
  llms.split("## Set up Open Artifacts for your user")[1]?.split("\n## ")[0] ??
  "";

describe("plan-aware setup steps in llms.txt", () => {
  it("relays data.warnings verbatim and nothing else", () => {
    expect(setup).toMatch(
      /Relay every `data\.warnings\[\]\.message` to the user verbatim/,
    );
    expect(setup).toMatch(
      /don't paraphrase the warnings or add free-plan notes/,
    );
    expect(setup).toContain("**`unknown`** is the common case");
    expect(setup).toContain("Workers Paid was detected");
  });

  it("asks solo or team instead of guessing", () => {
    expect(setup).toContain('"Just you, or a team?" Don\'t guess.');
    for (const flag of ["--solo", "--team", "--yes-paid"])
      expect(setup).toContain(flag);
  });

  it("handles the email step's action_required", () => {
    const email = setup.split("**Invite email (teams only).**")[1] ?? "";
    expect(email).toMatch(/When it returns `action_required`/);
    for (const field of [
      "`data.dashboard`",
      "`data.records`",
      "--yes-email-domain",
      "--email-domain",
    ])
      expect(email).toContain(field);
    expect(email).toMatch(/then run setup again/);
  });

  it("re-runs with --solo or --team when prereqs asks", () => {
    expect(setup).toMatch(
      /`action_required` with "Pass --solo or --team", ask the user[^.]*run again with `--solo` or `--team`/,
    );
  });

  it("reads invite email from the final state line, not a --check run", () => {
    expect(setup).toContain(
      '{"step": "state", "status": "ok", "message": "final"}',
    );
    for (const field of [
      "`data.plan`",
      "`data.team`",
      "`data.email`",
      "`data.emailDomain`",
    ])
      expect(setup).toContain(field);
    expect(setup).not.toContain("--check --json");
  });

  it("uses no em dashes", () => {
    expect(setup).not.toContain("—");
  });
});
