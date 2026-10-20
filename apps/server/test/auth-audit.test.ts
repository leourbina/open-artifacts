import { env } from "cloudflare:workers";
import { AUTH } from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { direct, mailer, seedUser, uniq } from "./auth-helpers.js";
import { fakeGoogle } from "./fixtures/fake-google.js";

// P2 Task 10: one auth event per sign-in outcome, and nothing secret in any log.
const app = createApp();
const APP = "http://app.localhost";
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
afterEach(() => vi.restoreAllMocks());

function capture() {
  const lines: string[] = [];
  for (const k of ["log", "warn", "error"] as const)
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
  return {
    lines,
    events: () =>
      lines
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l.evt === "auth"),
  };
}
const get = (e: Env, path: string, cookie?: string) =>
  app.fetch(
    new Request(`${APP}${path}`, cookie ? { headers: { cookie } } : {}),
    e,
    ctx,
  );
const post = async (e: Env, path: string, body: unknown, cookie?: string) => {
  const waits: Promise<unknown>[] = [];
  const r = await app.fetch(
    new Request(`${APP}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oa-request": "1",
        "sec-fetch-site": "same-origin",
        "cf-connecting-ip": "198.51.100.77",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
    e,
    {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException() {},
    } as never,
  );
  await Promise.all(waits);
  return r;
};

async function google(e: Env, claims: Record<string, unknown>) {
  const g = await fakeGoogle();
  const start = await get(e, `${AUTH.loginGoogle}?next=/`);
  const u = new URL(start.headers.get("location") ?? "");
  const cookie =
    start.headers
      .getSetCookie()
      .find((c) => /oa_oidc_/.test(c))
      ?.split(";")[0] ?? "";
  const code = g.issueCode(
    { nonce: u.searchParams.get("nonce"), ...claims },
    u.searchParams.get("code_challenge") as string,
  );
  return get(
    e,
    `${AUTH.callbackGoogle}?state=${u.searchParams.get("state")}&code=${code}`,
    cookie,
  );
}

describe("auth events", () => {
  it("each sign-in outcome logs exactly one auth event, with no email or code anywhere", async () => {
    const cap = capture();
    const e = direct();
    const ok = uniq("ok");
    await google(e, { email: ok, sub: `s-${ok}` });
    await google(e, { email: uniq("t"), hd: "b.com" });
    const conflict = uniq("c");
    await seedUser(conflict, "member", { googleSub: `old-${conflict}` });
    await google(e, { email: conflict, sub: `new-${conflict}` });

    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    const m = mailer();
    const em = { ...e, ...m.env } as Env;
    const req = await post(em, AUTH.codeRequest, { email: guest });
    const pending = req.headers
      .getSetCookie()
      .find((c) => c.startsWith("oa_code="))
      ?.split(";")[0];
    const bad = await post(em, AUTH.codeVerify, { code: "00000000" }, pending);
    const pending2 = bad.headers
      .getSetCookie()
      .find((c) => c.startsWith("oa_code="))
      ?.split(";")[0];
    const code = m.codeFor(guest);
    await post(em, AUTH.codeVerify, { code }, pending2);

    const ev = cap.events();
    expect(ev.map((x) => [x.provider, x.outcome, x.stage ?? null])).toEqual([
      ["google", "ok", null],
      ["google", "refused", "tenant"],
      ["google", "refused", "identity_conflict"],
      ["code", "refused", "invalid_code"],
      ["code", "ok", null],
    ]);
    const all = cap.lines.join("\n");
    for (const secret of [ok, guest, conflict, code, env.SESSION_SECRET])
      expect(all).not.toContain(secret);
    expect(all).not.toMatch(/\b\d{8}\b/);
    expect(all).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
  });

  it("an Access state failure logs one refused event", async () => {
    const cap = capture();
    await get(env, `${AUTH.callback}?state=s&code=c`);
    expect(cap.events()).toEqual([
      { evt: "auth", provider: "access", outcome: "refused", stage: "state" },
    ]);
  });
});
