import { decide, warnings } from "../../../../scripts/setup/src/plan.ts";
import type { Ctx } from "../../../../scripts/setup/src/step.ts";

type Row = { code: string; message: string };

/**
 * Every `data.warnings` entry setup can send, read from scripts/setup: the
 * plan notes (as on an unknown plan), then the `--browser` one, which decide()
 * adds for a team-or-solo install with --browser on a plan that isn't paid.
 */
export async function planWarnings(): Promise<Row[]> {
  const ctx = {
    opts: {
      teamChoice: false,
      browserFlag: true,
      interactive: false,
      check: false,
    },
    notes: [],
  } as unknown as Ctx;
  const extra = await decide({}, ctx, "unknown");
  return [...warnings("unknown"), ...extra].map(({ code, message }) => ({
    code,
    message,
  }));
}

/** The setup.md table for {PLAN_WARNINGS_TABLE}. */
export async function planWarningsTable(): Promise<string> {
  const rows = (await planWarnings()).map(
    (w) => `| \`${w.code}\` | ${w.message.replaceAll("|", "\\|")} |`,
  );
  return ["| Code | Message |", "|---|---|", ...rows].join("\n");
}
