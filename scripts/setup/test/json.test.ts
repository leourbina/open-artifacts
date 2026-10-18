import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { ROOT, STATE } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

type W = ReturnType<typeof world>;
const parsed = (w: W) => w.lines.map((l) => JSON.parse(l));
const last = (w: W) => parsed(w).at(-1);
/** --json without --yes: still never prompts. */
const JSON_ONLY = HOSTS.filter((a) => a !== "--yes");
const without = (flag: string) =>
  JSON_ONLY.filter((a, i) => a !== flag && JSON_ONLY[i - 1] !== flag);

describe("--json is non-interactive", () => {
  it("a missing required flag is action_required naming it, exit 2", async () => {
    for (const flag of ["--app-host", "--content-host", "--owner-email"]) {
      const w = world();
      expect(await run(without(flag), w.deps, ROOT)).toBe(2);
      expect(w.prompts).toEqual([]);
      expect(last(w)).toMatchObject({
        step: "args",
        status: "action_required",
      });
      expect(last(w).message).toContain(flag);
    }
  });

  it("--yes without --json still errors on a missing flag", async () => {
    const w = world();
    const human = HOSTS.filter(
      (a, i) =>
        a !== "--json" && HOSTS[i - 1] !== "--app-host" && a !== "--app-host",
    );
    expect(await run(human, w.deps, ROOT)).toBe(1);
    expect(w.lines[0]).toMatch(/^✗ args: missing --app-host/);
  });

  it("a --name conflict is action_required, no confirmation prompt", async () => {
    const w = world({ state: { name: "open-artifacts" } });
    expect(await run([...JSON_ONLY, "--name", "other"], w.deps, ROOT)).toBe(2);
    expect(w.prompts).toEqual([]);
    expect(last(w)).toMatchObject({ step: "args", status: "action_required" });
    expect(last(w).message).toContain("--name");
    expect(JSON.parse(w.files.get(STATE) ?? "{}").name).toBe("open-artifacts");
  });

  it("several accounts are action_required naming --account-id", async () => {
    const w = world({ accounts: ["acc1", "acc2"] });
    expect(await run(JSON_ONLY, w.deps, ROOT)).toBe(2);
    expect(w.prompts).toEqual([]);
    expect(last(w)).toMatchObject({
      step: "prereqs",
      status: "action_required",
    });
    expect(last(w).message).toContain("--account-id");
    expect(w.creates).toEqual([]);
  });

  it("an Access 403 points to OA_ACCESS_TOKEN without prompting", async () => {
    const w = world({ org: "forbidden" });
    expect(await run(JSON_ONLY, w.deps, ROOT)).toBe(2);
    expect(w.prompts).toEqual([]);
    expect(last(w)).toMatchObject({
      step: "access",
      status: "action_required",
    });
    expect(last(w).message).toContain("OA_ACCESS_TOKEN");
  });

  it("the optional ANALYTICS_TOKEN prompt is skipped", async () => {
    const w = world();
    expect(await run(JSON_ONLY, w.deps, ROOT)).toBe(0);
    expect(w.prompts).toEqual([]);
    expect(w.ops).not.toContain("put ANALYTICS_TOKEN");
  });
});

describe("welcome link", () => {
  it("selftest and agent-config emit welcomeUrl when published this run; never persisted", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    const url = "https://app.example.com/a/art1";
    const by = (s: string) => parsed(w).find((j) => j.step === s);
    expect(by("selftest").data.welcomeUrl).toBe(url);
    expect(by("agent-config").data.welcomeUrl).toBe(url);
    expect(w.files.get(STATE)).not.toContain("/a/art1");
    w.lines.length = 0;
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(by("selftest").data.welcomeUrl).toBeUndefined();
    expect(by("agent-config").data.welcomeUrl).toBeUndefined();
    const h = world();
    expect(
      await run(
        HOSTS.filter((a) => a !== "--json"),
        h.deps,
        ROOT,
      ),
    ).toBe(0);
    const cfg = h.lines.find((l) => l.startsWith("✓ agent-config")) ?? "";
    expect(cfg).toContain(url);
  });
});
