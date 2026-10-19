import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { DASH_SENDING, records } from "../src/steps/email.ts";
import { renderConfig } from "../src/steps/resources.ts";
import { ROOT, STATE } from "./fakes.ts";
import { HOSTS, onboarded, world } from "./world.ts";

const CONFIG = join(ROOT, "apps/server/wrangler.jsonc");
const TEMPLATE = readFileSync(
  join(import.meta.dirname, "../../../apps/server/wrangler.template.jsonc"),
  "utf8",
);
const D = "mail.app.example.com";
const TEAM = [...HOSTS, "--team", "--yes-paid"];
const parse = (lines: string[]) => lines.map((l) => JSON.parse(l));
const line = (lines: string[], step: string) =>
  parse(lines).find((j) => j.step === step);
const cfg = (w: { files: Map<string, string> }) =>
  JSON.parse(w.files.get(CONFIG) ?? "");
const interactive = HOSTS.filter((a) => a !== "--yes" && a !== "--json");

describe("team/solo and the email step", () => {
  it("solo (the non-interactive default) omits the binding and EMAIL_FROM", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    const c = cfg(w);
    expect(c).not.toHaveProperty("send_email");
    expect(c.vars).not.toHaveProperty("EMAIL_FROM");
    expect(w.state()).toMatchObject({ team: false, email: false });
    expect(line(w.lines, "email")).toMatchObject({ status: "skipped" });
  });

  it("--yes without --json also defaults to solo", async () => {
    const w = world();
    const yes = HOSTS.filter((a) => a !== "--json");
    expect(await run(yes, w.deps, ROOT)).toBe(0);
    expect(w.state()).toMatchObject({ team: false, email: false });
  });

  it("team with onboarded DNS is done and renders the binding", async () => {
    const w = world({ dns: onboarded(D) });
    expect(await run(TEAM, w.deps, ROOT)).toBe(0);
    const c = cfg(w);
    expect(c.send_email).toEqual([{ name: "EMAIL" }]);
    expect(c.vars.EMAIL_FROM).toBe(`noreply@${D}`);
    expect(w.state()).toMatchObject({
      team: true,
      email: true,
      emailDomain: D,
    });
    expect(line(w.lines, "email")).toMatchObject({ status: "skipped" });
    expect(line(w.lines, "selftest").status).toBe("ok");
    expect(line(w.lines, "selftest").message).toContain("EMAIL binding");
  });

  it("reads DNS by DoH when the token cannot read DNS records", async () => {
    const w = world({ dns: onboarded(D), dnsForbidden: true });
    expect(await run(TEAM, w.deps, ROOT)).toBe(0);
    expect(w.hits.some((h) => h.startsWith("DoH "))).toBe(true);
  });

  it("team with DNS missing is action_required with the link and the records", async () => {
    const w = world();
    expect(await run(TEAM, w.deps, ROOT)).toBe(2);
    const l = parse(w.lines).at(-1);
    expect(l).toMatchObject({ step: "email", status: "action_required" });
    expect(l.message).toContain(DASH_SENDING);
    expect(l.message).toContain(D);
    expect(l.data.domain).toBe(D);
    expect(l.data.records).toEqual(records(D));
    expect(l.data.records.map((r: { name: string }) => r.name)).toEqual([
      `cf-bounce.${D}`,
      `cf-bounce.${D}`,
      `cf-bounce._domainkey.${D}`,
      `_dmarc.${D}`,
    ]);
    expect(w.ops).not.toContain("deploy");
    // Idempotent: once onboarded, the re-run re-checks and passes.
    w.dns.push(...onboarded(D));
    w.lines.length = 0;
    expect(await run([...HOSTS, "--yes-paid"], w.deps, ROOT)).toBe(0);
    expect(line(w.lines, "email").status).toBe("skipped");
  });

  it("existing MX or SPF elsewhere needs confirmation", async () => {
    const dns = [
      { name: D, type: "MX", content: "mx.other-provider.net" },
      { name: D, type: "TXT", content: '"v=spf1 include:other.net ~all"' },
    ];
    const w = world({ dns });
    expect(await run(TEAM, w.deps, ROOT)).toBe(2);
    const l = parse(w.lines).at(-1);
    expect(l).toMatchObject({ step: "email", status: "action_required" });
    expect(l.message).toContain("--yes-email-domain");
    expect(l.message).toContain("mx.other-provider.net");
    const w2 = world({ dns });
    expect(await run([...TEAM, "--yes-email-domain"], w2.deps, ROOT)).toBe(2);
    const l2 = parse(w2.lines).at(-1);
    expect(l2.message).toContain(DASH_SENDING);
    expect(l2.data.records).toEqual(records(D));
  });

  it("the apex with Google MX and no _dmarc gets a strong p=reject warning", async () => {
    const dns = [
      { name: "example.com", type: "MX", content: "aspmx.l.google.com" },
    ];
    const argv = [...TEAM, "--email-domain", "example.com"];
    const w = world({ dns });
    expect(await run(argv, w.deps, ROOT)).toBe(2);
    const l = parse(w.lines).at(-1);
    expect(l).toMatchObject({ step: "email", status: "action_required" });
    expect(l.message).toContain("p=reject");
    expect(l.message).toContain("apex");
    expect(l.message).toContain("aspmx.l.google.com");
    // Interactive: a "no" stops; nothing is reported as onboarding.
    const no = world({ dns, answers: ["team", "", "y", "n"] });
    const ia = [...interactive, "--email-domain", "example.com"];
    expect(await run(ia, no.deps, ROOT)).toBe(2);
    expect(no.prompts.join("\n")).toContain("p=reject");
  });

  it("--team --no-email omits the binding", async () => {
    const w = world();
    expect(await run([...TEAM, "--no-email"], w.deps, ROOT)).toBe(0);
    expect(cfg(w)).not.toHaveProperty("send_email");
    expect(w.state()).toMatchObject({ team: true, email: false });
  });

  it("team on Free (no --yes-paid, plan unknown) warns and falls back to email off", async () => {
    const w = world();
    expect(await run([...HOSTS, "--team"], w.deps, ROOT)).toBe(0);
    const l = line(w.lines, "email");
    expect(l.message).toContain("invites can't be sent");
    expect(l.message).toContain("--yes-paid");
    expect(cfg(w)).not.toHaveProperty("send_email");
    expect(w.state()).toMatchObject({ team: true, email: false });
  });

  it("detects Workers Paid from the account subscriptions when readable", async () => {
    const w = world({
      dns: onboarded(D),
      subscriptions: [
        { rate_plan: { id: "workers_paid", public_name: "Workers Paid" } },
      ],
    });
    expect(await run([...HOSTS, "--team"], w.deps, ROOT)).toBe(0);
    expect(cfg(w).send_email).toEqual([{ name: "EMAIL" }]);
  });

  it("--upgrade keeps saved team/email/emailDomain", async () => {
    const w = world({ dns: onboarded(D) });
    expect(await run(TEAM, w.deps, ROOT)).toBe(0);
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(cfg(w).send_email).toEqual([{ name: "EMAIL" }]);
    expect(w.state()).toMatchObject({
      team: true,
      email: true,
      emailDomain: D,
    });
    const s = world();
    expect(await run(HOSTS, s.deps, ROOT)).toBe(0);
    expect(await run([...HOSTS, "--upgrade"], s.deps, ROOT)).toBe(0);
    expect(s.state()).toMatchObject({ team: false, email: false });
    expect(cfg(s)).not.toHaveProperty("send_email");
  });

  it("asks 'Just you, or a team?' interactively", async () => {
    const w = world({ dns: onboarded(D), answers: ["team", "", "y"] });
    expect(await run(interactive, w.deps, ROOT)).toBe(0);
    expect(w.prompts[0]).toContain("Just you, or a team?");
    expect(w.prompts.join("\n")).toContain("Workers Paid");
    expect(w.state()).toMatchObject({ team: true, email: true });
  });

  it("selftest fails when the deployed Worker lacks the EMAIL binding", async () => {
    const w = world({ dns: onboarded(D), dropSendEmail: true });
    expect(await run(TEAM, w.deps, ROOT)).toBe(1);
    const l = parse(w.lines).at(-1);
    expect(l).toMatchObject({ step: "selftest", status: "error" });
    expect(l.message).toContain("EMAIL");
  });

  it("--check reports team, email, emailDomain", async () => {
    const w = world({ dns: onboarded(D) });
    await run(TEAM, w.deps, ROOT);
    w.lines.length = 0;
    await run([...HOSTS.filter((a) => a !== "--yes"), "--check"], w.deps, ROOT);
    expect(parse(w.lines).at(-1).data).toMatchObject({
      team: true,
      email: true,
      emailDomain: D,
    });
  });

  it("--help lists the new flags", async () => {
    const w = world();
    await run(["--help"], w.deps, ROOT);
    const h = w.lines.join("\n");
    for (const f of [
      "--solo",
      "--team",
      "--no-email",
      "--email-domain",
      "--yes-email-domain",
      "--yes-paid",
    ])
      expect(h).toContain(f);
  });

  it("--solo and --team conflict", async () => {
    const w = world();
    expect(await run([...HOSTS, "--solo", "--team"], w.deps, ROOT)).toBe(1);
  });
});

describe("rendered config stays valid JSON", () => {
  const VARS = {
    WORKER_NAME: "w",
    APP_HOST: "a.example.com",
    CONTENT_HOST: "c.example.com",
    OWNER_EMAIL: "o@example.com",
    D1_NAME: "d",
    D1_ID: "1",
    R2_BUCKET: "r",
    KV_ID: "k",
    CF_ACCOUNT_ID: "acc",
    ACCESS_TEAM_DOMAIN: "t",
    ACCESS_CLIENT_ID: "i",
    EMAIL_FROM: "noreply@mail.a.example.com",
  };
  it("parses with email on and off, browser on and off", () => {
    for (const browser of [true, false])
      for (const email of [true, false]) {
        const c = JSON.parse(renderConfig(TEMPLATE, VARS, browser, email));
        expect("send_email" in c).toBe(email);
        expect("EMAIL_FROM" in c.vars).toBe(email);
        expect(c.vars.ENVIRONMENT).toBe("production");
      }
    const on = JSON.parse(renderConfig(TEMPLATE, VARS, true, true));
    expect(on.send_email).toEqual([{ name: "EMAIL" }]);
    expect(on.vars.EMAIL_FROM).toBe("noreply@mail.a.example.com");
  });
  it("the template itself is strict JSON with the email lines", () => {
    const t = JSON.parse(TEMPLATE);
    expect(t.send_email).toEqual([{ name: "EMAIL" }]);
    expect(t.vars.EMAIL_FROM).toBe("{{EMAIL_FROM}}");
  });
  it("email off needs no EMAIL_FROM value", () => {
    const { EMAIL_FROM: _, ...rest } = VARS;
    expect(() => renderConfig(TEMPLATE, rest, true, false)).not.toThrow();
  });
});

describe("state file", () => {
  it("persists the choice like browser", async () => {
    const w = world({ dns: onboarded(D) });
    await run(TEAM, w.deps, ROOT);
    const s = JSON.parse(w.files.get(STATE) ?? "");
    expect(s).toMatchObject({ team: true, email: true, emailDomain: D });
  });
});
