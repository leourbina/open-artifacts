import { describe, expect, it } from "vitest";
import { makeApi, makeWrangler, realDeps } from "../src/cf.ts";
import { run } from "../src/index.ts";
import type { Ctx, Step } from "../src/step.ts";
import { core, envelope, FLAGS, ROOT, STATE } from "./fakes.ts";

const allLines: string[] = [];
const go = async (
  c: ReturnType<typeof core>,
  argv: string[],
  steps: Step[] = [],
) => {
  const code = await run(argv, c.deps, ROOT, steps);
  allLines.push(...c.lines.filter(() => argv.includes("--json")));
  return code;
};
const parsed = (c: ReturnType<typeof core>) =>
  c.lines.map((l) => JSON.parse(l));
const without = (flag: string) =>
  FLAGS.filter((a, i) => a !== flag && FLAGS[i - 1] !== flag);
let seen: Ctx | undefined;
const marker: Step = {
  name: "marker",
  check: async (s, ctx) => {
    seen = ctx;
    return s.d1Id ? "done" : "todo";
  },
  apply: async (s) => {
    s.d1Id = "d1";
    return undefined;
  },
};

describe("runner", () => {
  it("applies todo steps, persists state, then reports skipped", async () => {
    const c = core();
    expect(await go(c, FLAGS, [marker])).toBe(0);
    expect(parsed(c).find((j) => j.step === "marker")).toMatchObject({
      step: "marker",
      status: "ok",
    });
    expect(c.state()).toMatchObject({
      name: "open-artifacts",
      appHost: "app.example.com",
      d1Id: "d1",
    });
    c.lines.length = 0;
    expect(await go(c, FLAGS, [marker])).toBe(0);
    expect(parsed(c)).toEqual([
      { step: "marker", status: "skipped", message: "already done" },
      { step: "state", status: "ok", message: "final", data: {} },
    ]);
  });

  it("exit 2 on action_required stops the run; exit 1 on error", async () => {
    const ar: Step = {
      ...marker,
      apply: async () => ({
        status: "action_required",
        message: "do X",
        data: { u: 1 },
      }),
    };
    const c = core();
    expect(await go(c, FLAGS, [ar, marker])).toBe(2);
    expect(parsed(c)).toEqual([
      {
        step: "marker",
        status: "action_required",
        message: "do X",
        data: { u: 1 },
      },
    ]);
    const boom: Step = {
      ...marker,
      check: async () => {
        throw new Error("boom");
      },
    };
    const c2 = core();
    expect(await go(c2, FLAGS, [boom])).toBe(1);
    expect(parsed(c2)[0]).toMatchObject({ status: "error", message: "boom" });
  });

  it("flags beat state, state beats prompts, CLOUDFLARE_ACCOUNT_ID is the last default", async () => {
    const saved = {
      name: "oa-x",
      appHost: "s.example.com",
      contentHost: "sc.example.com",
      ownerEmail: "s@example.com",
    };
    const c = core({
      files: { [STATE]: JSON.stringify(saved) },
      env: { CLOUDFLARE_ACCOUNT_ID: "envacc" },
    });
    expect(
      await go(c, ["--json", "--app-host", "f.example.com"], [marker]),
    ).toBe(0);
    expect(c.prompts).toEqual([]);
    expect(seen?.opts).toMatchObject({
      ...saved,
      appHost: "f.example.com",
      accountId: "envacc",
    });
  });

  it("prompts fill missing values; --yes names the missing flag", async () => {
    const c = core({
      answers: ["app.example.com", "c.example.com", "o@example.com"],
    });
    expect(await go(c, [], [marker])).toBe(0);
    expect(c.prompts).toHaveLength(3);
    for (const flag of ["--app-host", "--content-host", "--owner-email"]) {
      const c2 = core();
      const yesOnly = without(flag).filter((a) => a !== "--json");
      expect(await go(c2, yesOnly, [marker])).toBe(1);
      expect(c2.lines[0]).toMatch(new RegExp(`^✗ args: missing ${flag}`));
    }
  });

  it("validates hosts, email and name", async () => {
    for (const [flag, bad] of [
      ["--app-host", "a b"],
      ["--content-host", 'x".com'],
      ["--owner-email", "nope"],
      ["--name", "Open_Artifacts"],
    ]) {
      const c = core();
      expect(await go(c, [...without(flag), flag, bad], [marker])).toBe(1);
      expect(parsed(c)[0].message).toContain(flag);
    }
  });

  it("a --name that conflicts with saved state needs confirmation", async () => {
    const files = { [STATE]: JSON.stringify({ name: "open-artifacts" }) };
    const c = core({ files });
    const yesOnly = without("--json");
    expect(await go(c, [...yesOnly, "--name", "other"], [marker])).toBe(1);
    expect(c.lines[0]).toContain("--name");
    const j = core({ files });
    expect(await go(j, [...FLAGS, "--name", "other"], [marker])).toBe(2);
    expect(parsed(j)[0]).toMatchObject({
      step: "args",
      status: "action_required",
    });
    const tty = without("--yes").filter((a) => a !== "--json");
    const no = core({ files, answers: ["n"] });
    expect(await go(no, [...tty, "--name", "other"], [marker])).toBe(1);
    const yes = core({ files, answers: ["y"] });
    expect(await go(yes, [...tty, "--name", "other"], [marker])).toBe(0);
    expect(yes.state().name).toBe("other");
  });

  it("a corrupt state file is a JSON error line", async () => {
    const c = core({ files: { [STATE]: "{nope" } });
    expect(await go(c, FLAGS, [marker])).toBe(1);
    expect(parsed(c)[0]).toMatchObject({ step: "args", status: "error" });
  });

  it("every --json line parses as {step,status,message}", () => {
    expect(allLines.length).toBeGreaterThan(10);
    for (const l of allLines)
      expect(Object.keys(JSON.parse(l))).toEqual(
        expect.arrayContaining(["step", "status", "message"]),
      );
  });
});

describe("cf", () => {
  const apiOf = (c: ReturnType<typeof core>) =>
    makeApi(
      c.deps,
      makeWrangler(c.deps, ROOT, () => undefined),
    );

  it("unwraps the v4 envelope with a bearer token from wrangler", async () => {
    let auth = "";
    const c = core({
      stdout: '{"type":"oauth","token":"sekret"}',
      fetch: async (_u, init) => {
        auth = new Headers(init?.headers).get("authorization") ?? "";
        return envelope([{ id: 1 }]);
      },
    });
    const api = apiOf(c);
    expect(await api("GET", "/zones")).toEqual([{ id: 1 }]);
    expect(auth).toBe("Bearer sekret");
  });

  it("an error envelope throws with status and messages", async () => {
    const c = core({
      env: { CLOUDFLARE_API_TOKEN: "t" },
      fetch: async () =>
        envelope(null, 403, [{ message: "Authentication error" }]),
    });
    const api = apiOf(c);
    await expect(api("GET", "/x")).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("Authentication error"),
    });
  });

  it("an unreadable wrangler token is a generic error", async () => {
    for (const out of ["not json", '{"type":"oauth"}']) {
      const c = core({ stdout: out });
      const api = apiOf(c);
      await expect(api("GET", "/x")).rejects.toThrow(
        "could not read an API token",
      );
    }
  });

  it("the token never appears in output", async () => {
    const c = core({
      stdout: '{"token":"sekret"}',
      fetch: async () => envelope(null, 403, [{ message: "denied" }]),
    });
    const caller: Step = {
      ...marker,
      check: async (_s, ctx) => {
        await ctx.api("GET", "/zones");
        return "done";
      },
    };
    expect(await go(c, FLAGS, [caller])).toBe(1);
    expect(c.lines.join("\n")).not.toContain("sekret");
    expect(c.files.get(STATE)).not.toContain("sekret");
  });

  it("exec always closes stdin", async () => {
    expect(await realDeps().exec("cat", [])).toMatchObject({
      code: 0,
      stdout: "",
    });
  });
});
