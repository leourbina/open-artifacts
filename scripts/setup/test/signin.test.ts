import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HELP, run } from "../src/index.ts";
import {
  PROVIDERS,
  resolveSignin,
  SIGNIN,
  SIGNIN_VARS,
  signinProblems,
} from "../src/signin.ts";
import { ROOT, STATE } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

const CONFIG = join(ROOT, "apps/server/wrangler.jsonc");
type W = ReturnType<typeof world>;
const cfgVars = (w: W) => JSON.parse(w.files.get(CONFIG) ?? "{}").vars ?? {};
const deployedVars = (w: W) => JSON.parse(w.deployed() ?? "{}").vars ?? {};
const line = (w: W, s: string) =>
  w.lines.map((l) => JSON.parse(l)).find((j) => j.step === s);
const GOOGLE = [
  ...["--auth-providers", "access,google,email"],
  ...["--auth-domains", "Example.com, example.org"],
  ...["--auth-domain-join", "member"],
  ...["--google-client-id", "123-abc.apps.googleusercontent.com"],
  ...["--code-emails-per-day", "50"],
];
const LIVE = {
  AUTH_PROVIDERS: "access,google,email",
  AUTH_DOMAINS: "example.com,example.org",
  AUTH_DOMAIN_JOIN: "member",
  GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
  CODE_EMAILS_PER_DAY: "50",
};
const empty = Object.fromEntries(SIGNIN_VARS.map((k) => [k, ""])) as Record<
  (typeof SIGNIN_VARS)[number],
  string
>;
/** A world whose Worker was deployed with GOOGLE; then state is dropped (stateless CI). */
async function deployedWithGoogle(o: Parameters<typeof world>[0] = {}) {
  const w = world({ secrets: ["GOOGLE_CLIENT_SECRET"], ...o });
  expect(await run([...HOSTS, ...GOOGLE], w.deps, ROOT)).toBe(0);
  w.files.delete(STATE);
  w.lines.length = 0;
  w.ops.length = 0;
  return w;
}
const deploys = (w: W) =>
  w.ops.filter((o) => o === "deploy" || o.startsWith("migrate"));

describe("setup keeps direct sign-in vars across upgrades", () => {
  it("every SIGNIN flag is a setup option", async () => {
    const src = readFileSync(
      join(import.meta.dirname, "../src/index.ts"),
      "utf8",
    );
    for (const f of Object.values(SIGNIN))
      expect(src, f).toContain(`"${f}": { type: "string" },`);
  });

  it("--help documents the sign-in flags and how to clear them", () => {
    for (const f of [
      "--auth-providers",
      "--auth-domains",
      "--auth-domain-join",
      "--google-client-id",
      "--turnstile-site-key",
      "--email-code-domain",
      "--code-emails-per-day",
    ])
      expect(HELP, f).toContain(f);
    expect(HELP).toMatch(/empty value.*clears/i);
  });

  it("a fresh install with no flags renders none (Access only)", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    for (const k of SIGNIN_VARS)
      expect(deployedVars(w), k).not.toHaveProperty(k);
  });

  it("flags render normalized into the deployed config", async () => {
    const w = await deployedWithGoogle();
    expect(w).toBeDefined();
    expect(deployedVars(w)).toMatchObject(LIVE);
  });

  it("an upgrade with no auth flags keeps the live Worker's sign-in vars", async () => {
    const w = await deployedWithGoogle();
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(deploys(w)).toContain("deploy");
    expect(deployedVars(w)).toMatchObject(LIVE);
    expect(cfgVars(w)).toMatchObject(LIVE);
    expect(line(w, "deploy").message).toContain("kept the deployed");
  });

  it("an upgrade by name only (no hosts, no state) keeps them too", async () => {
    const w = await deployedWithGoogle();
    expect(
      await run(
        ["--name", "open-artifacts", "--upgrade", "--yes", "--json", "--solo"],
        w.deps,
        ROOT,
      ),
    ).toBe(0);
    expect(deployedVars(w)).toMatchObject(LIVE);
  });

  it("a flag overrides the live value, with a note", async () => {
    const w = await deployedWithGoogle();
    const argv = [...HOSTS, "--upgrade", "--auth-domain-join", "invite"];
    expect(await run(argv, w.deps, ROOT)).toBe(0);
    expect(deployedVars(w)).toMatchObject({
      ...LIVE,
      AUTH_DOMAIN_JOIN: "invite",
    });
    expect(line(w, "deploy").message).toContain(
      "--auth-domain-join invite differs from the deployed AUTH_DOMAIN_JOIN member; using the flag",
    );
  });

  it("--auth-providers access switches back to Access only; an empty value removes a var", async () => {
    const w = await deployedWithGoogle();
    const argv = [
      ...HOSTS,
      "--upgrade",
      ...["--auth-providers", "access"],
      ...["--google-client-id", ""],
      "--auth-domain-join=",
    ];
    expect(await run(argv, w.deps, ROOT)).toBe(0);
    const v = deployedVars(w);
    expect(v.AUTH_PROVIDERS).toBe("access");
    expect(v).not.toHaveProperty("GOOGLE_CLIENT_ID");
    expect(v).not.toHaveProperty("AUTH_DOMAIN_JOIN");
    expect(v.AUTH_DOMAINS).toBe(LIVE.AUTH_DOMAINS);
  });

  it("--check reports the sign-in vars it would deploy", async () => {
    const w = await deployedWithGoogle();
    await run([...HOSTS, "--upgrade", "--check"], w.deps, ROOT);
    expect(line(w, "deploy").data.signin).toEqual(LIVE);
  });

  it("warns when google is on and the Worker has no GOOGLE_CLIENT_SECRET", async () => {
    const w = world();
    expect(await run([...HOSTS, ...GOOGLE], w.deps, ROOT)).toBe(0);
    expect(line(w, "deploy").message).toMatch(
      /warning: .*GOOGLE_CLIENT_SECRET/,
    );
    const ok = world({ secrets: ["GOOGLE_CLIENT_SECRET"] });
    expect(await run([...HOSTS, ...GOOGLE], ok.deps, ROOT)).toBe(0);
    expect(line(ok, "deploy").message).not.toContain("GOOGLE_CLIENT_SECRET");
  });

  it("the saved values stand in when the live Worker is unreadable", async () => {
    const o: Parameters<typeof world>[0] = {
      secrets: ["GOOGLE_CLIENT_SECRET"],
    };
    const w = world(o);
    expect(await run([...HOSTS, ...GOOGLE], w.deps, ROOT)).toBe(0);
    expect(w.state().signin).toMatchObject(LIVE);
    o.settingsFail = true;
    w.ops.length = 0;
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(w.ops).toContain("deploy");
    expect(deployedVars(w)).toMatchObject(LIVE);
  });

  it("an unreadable Worker with no saved sign-in values: a full setup warns", async () => {
    const w = world({ settingsFail: true });
    expect(await run([...HOSTS, "--plan", "free"], w.deps, ROOT)).toBe(0);
    expect(line(w, "deploy").message).toMatch(
      /warning: could not read the live Worker's sign-in vars/,
    );
  });

  it("an unreadable Worker with no saved sign-in values: --upgrade refuses before deploying", async () => {
    const o: Parameters<typeof world>[0] = {};
    const w = world(o);
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    // State saved before setup kept sign-in vars (stateless, it fails earlier on the read).
    const st = w.state();
    delete st.signin;
    w.files.set(STATE, JSON.stringify(st));
    o.settingsFail = true;
    w.ops.length = 0;
    w.lines.length = 0;
    const code = await run(
      [...HOSTS, "--upgrade", "--plan", "free"],
      w.deps,
      ROOT,
    );
    expect(code).toBe(2);
    expect(line(w, "deploy").message).toMatch(
      /could not read the live Worker's sign-in vars.*--auth-providers/,
    );
    expect(deploys(w)).toEqual([]);
  });
});

describe("fail closed before any deploy call", () => {
  const refused = async (argv: string[], re: RegExp) => {
    const w = world({ secrets: ["GOOGLE_CLIENT_SECRET"] });
    const code = await run([...HOSTS, ...argv], w.deps, ROOT);
    expect(code, argv.join(" ")).not.toBe(0);
    const said = w.lines.map((l) => JSON.parse(l).message).join("\n");
    expect(said, argv.join(" ")).toMatch(re);
    expect(deploys(w), argv.join(" ")).toEqual([]);
    expect(w.deployed()).toBeUndefined();
  };

  it("google without GOOGLE_CLIENT_ID or AUTH_DOMAINS", async () => {
    await refused(
      ["--auth-providers", "google", "--auth-domains", "example.com"],
      /GOOGLE_CLIENT_ID is empty/,
    );
    await refused(
      ["--auth-providers", "access,google", "--google-client-id", "x.apps"],
      /AUTH_DOMAINS is empty/,
    );
  });

  it("an unknown provider", async () => {
    await refused(
      ["--auth-providers", "access,okta"],
      /unknown provider "okta"/,
    );
    await refused(["--auth-providers", ","], /lists no provider/);
  });

  it("AUTH_DOMAIN_JOIN not invite or member", async () => {
    await refused(["--auth-domain-join", "everyone"], /AUTH_DOMAIN_JOIN/);
  });

  it("EMAIL_CODE_DOMAIN not on, CODE_EMAILS_PER_DAY out of range", async () => {
    await refused(["--email-code-domain", "yes"], /EMAIL_CODE_DOMAIN/);
    await refused(["--code-emails-per-day", "10001"], /CODE_EMAILS_PER_DAY/);
  });

  it("a malformed domain", async () => {
    await refused(
      ["--auth-domains", "example.com,not a domain"],
      /invalid domain "not a domain"/,
    );
    await refused(["--auth-domains", "localhost"], /invalid domain/);
  });

  it("a flag that breaks the live combination (google on, domains cleared)", async () => {
    const w = await deployedWithGoogle();
    const before = w.deployed();
    const code = await run(
      [...HOSTS, "--upgrade", "--auth-domains", ""],
      w.deps,
      ROOT,
    );
    expect(code).toBe(1);
    expect(line(w, "deploy").message).toMatch(
      /refusing to deploy: .*AUTH_DOMAINS is empty/,
    );
    expect(deploys(w)).toEqual([]);
    expect(w.deployed()).toBe(before);
  });

  it("an invalid value on the live Worker is refused, not carried", async () => {
    const w = world({
      workerBindings: [
        { type: "plain_text", name: "AUTH_DOMAIN_JOIN", text: "open" },
      ],
    });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    expect(line(w, "deploy").message).toMatch(
      /refusing to deploy: AUTH_DOMAIN_JOIN: "open"/,
    );
    expect(deploys(w)).toEqual([]);
  });
});

describe("rules match the server", () => {
  it("PROVIDERS is apps/server/src/auth/config.ts's list", () => {
    const src = readFileSync(
      join(import.meta.dirname, "../../../apps/server/src/auth/config.ts"),
      "utf8",
    );
    const m = src.match(/const PROVIDERS[^=]*=\s*\[([^\]]*)\]/);
    expect(m?.[1]?.match(/"(\w+)"/g)?.map((s) => s.slice(1, -1))).toEqual([
      ...PROVIDERS,
    ]);
  });

  it("CODE_EMAILS_PER_DAY's cap is config.ts CODE_EMAILS_MAX", () => {
    const src = readFileSync(
      join(import.meta.dirname, "../../../apps/server/src/auth/config.ts"),
      "utf8",
    );
    expect(src).toContain("const CODE_EMAILS_MAX = 10_000;");
    expect(signinProblems({ ...empty, CODE_EMAILS_PER_DAY: "10000" })).toEqual(
      [],
    );
  });

  it("signinProblems: unset is fine; google needs both a client id and domains", () => {
    expect(signinProblems(empty)).toEqual([]);
    expect(
      signinProblems({ ...empty, AUTH_PROVIDERS: "google" }).join(";"),
    ).toMatch(/GOOGLE_CLIENT_ID.*AUTH_DOMAINS/);
    expect(signinProblems({ ...empty, ...LIVE })).toEqual([]);
  });

  it("resolveSignin: flag, then live; saved state only when live is unreadable", () => {
    const live = new Map(Object.entries({ AUTH_PROVIDERS: "access,google" }));
    const state = { AUTH_PROVIDERS: "access" };
    const r = resolveSignin({ flags: { AUTH_DOMAINS: "" }, live, state });
    expect(r.values.AUTH_PROVIDERS).toBe("access,google");
    expect(r.values.AUTH_DOMAINS).toBe("");
    expect(r.kept).toEqual(["AUTH_PROVIDERS"]);
    expect(r.missing).toEqual([]);
    const u = resolveSignin({ flags: {}, state });
    expect(u.values.AUTH_PROVIDERS).toBe("access");
    expect(u.missing).toContain("AUTH_DOMAINS");
  });
});
