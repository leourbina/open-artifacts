import { env } from "cloudflare:workers";
import { CODE_POLICY } from "@oa/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODE_LIMITS,
  counterBucket,
  createCode,
  deliverCode,
  emailKey,
  ipKey,
  takeRequestSlot,
  verifyCode,
} from "../src/auth/codes.js";
import { authConfig } from "../src/auth/config.js";
import { emailDailyCap } from "../src/email/send.js";
import { loginCodeEmail } from "../src/email/templates.js";
import type { Env } from "../src/env.js";
import { inviteMember } from "../src/services/members.js";
import { direct, mailer, seedUser, trial, uniq } from "./auth-helpers.js";
import { login } from "./helpers.js";

// P2 Task 7: emailed one-time codes.
const one = async <T>(sql: string, ...b: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...b)
    .first<T>()) as T;
const attemptsOf = async (rid: string) =>
  (
    await one<{ a: number }>(
      "select attempts a from login_codes where request_id = ?",
      rid,
    )
  )?.a;
const counter = async (key: string) =>
  (await one<{ n: number } | null>("select n from counters where key = ?", key))
    ?.n ?? 0;
const fillCounter = (
  key: string,
  n: number,
  kind: "day" | "hour" | "tenMin",
  now = Date.now(),
) =>
  env.DB.prepare(
    "insert into counters (key, n, day) values (?1, ?2, ?3) on conflict (key) do update set n = ?2, day = ?3",
  )
    .bind(key, n, counterBucket(kind, now))
    .run();
const withMail = (e: Env, m = mailer()) => ({ ...e, ...m.env }) as Env;

/** A code row with a known code (createCode with a fixed generator). */
async function fixedCode(
  e: Env,
  email: string,
  code: string,
  now = Date.now(),
) {
  const ek = await emailKey(e, email);
  const rid = `r-${crypto.randomUUID()}`;
  await createCode(e, ek, rid, now, () => code);
  return { ek, requestId: rid };
}

/** The start of UTC hour `h` on a fixed future day (clean buckets per test). */
const DAY0 =
  Date.UTC(2031, 0, 1) + Math.floor(Math.random() * 1000) * 86_400_000;
const hourStart = (h: number) => DAY0 + h * 3_600_000;

let E: string;
let cfg: ReturnType<typeof authConfig>;
const IP = "203.0.113.7";
beforeEach(() => {
  E = uniq("g", "x.com");
  cfg = authConfig(direct());
});

describe("codes at rest", () => {
  it("8 digits, uniform per position", async () => {
    const counts = Array.from({ length: 8 }, () => new Array(10).fill(0));
    const ek = await emailKey(env, E);
    for (let i = 0; i < 2000; i++) {
      const code = await createCode(env, ek, `u-${i}-${E}`, Date.now());
      expect(code).toMatch(/^\d{8}$/);
      [...code].forEach((d, p) => {
        counts[p][Number(d)]++;
      });
    }
    // 200 expected per cell; 5 sigma ≈ 67.
    for (const pos of counts)
      for (const n of pos) expect(Math.abs(n - 200)).toBeLessThan(67);
  });

  it("the row holds no plaintext email or code", async () => {
    const { requestId } = await fixedCode(env, E, "12345678");
    const row = JSON.stringify(
      await one("select * from login_codes where request_id = ?", requestId),
    );
    expect(row).not.toContain(E);
    expect(row).not.toContain("12345678");
  });

  it("keys are per install", async () => {
    const other = { ...env, SESSION_SECRET: "y".repeat(32) } as Env;
    expect(await emailKey(env, E)).not.toBe(await emailKey(other, E));
    expect(await ipKey(env, IP)).not.toBe(await ipKey(other, IP));
    expect(await emailKey(env, E.toUpperCase())).toBe(await emailKey(env, E));
  });
});

describe("verifyCode", () => {
  const v = (
    requestId: string,
    input: string,
    o: { ip?: string; now?: number; e?: Env } = {},
  ) =>
    verifyCode(o.e ?? env, cfg, {
      email: E,
      requestId,
      input,
      ip: o.ip ?? IP,
      now: o.now,
    });

  it.each(["1234 5678", "1234-5678", " 12345678 ", "1234\t5678", "12345678"])(
    "normalizes %j",
    async (input) => {
      const { requestId } = await fixedCode(env, E, "12345678");
      expect(await v(requestId, input)).toEqual({ ok: true });
    },
  );

  it("malformed input uses an attempt", async () => {
    const { requestId } = await fixedCode(env, E, "12345678");
    expect(await v(requestId, "1234 567")).toEqual({ ok: false });
    expect(await v(requestId, "1234a5678")).toEqual({ ok: false });
    expect(await attemptsOf(requestId)).toBe(2);
  });

  it("H2: 50 concurrent wrong guesses let exactly 5 through; the right code is then refused", async () => {
    const { requestId } = await fixedCode(env, E, "12345678");
    const rs = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        v(requestId, "00000000", { ip: `198.51.100.${i}` }),
      ),
    );
    expect(rs.every((r) => !r.ok)).toBe(true);
    expect(await attemptsOf(requestId)).toBe(5);
    expect(await v(requestId, "12345678")).toEqual({ ok: false });
  });

  it("single use", async () => {
    const { requestId } = await fixedCode(env, E, "12345678");
    expect(await v(requestId, "12345678")).toEqual({ ok: true });
    expect(await v(requestId, "12345678")).toEqual({ ok: false });
  });

  it("expired at TTL + 1 ms", async () => {
    const t0 = Date.now();
    const { requestId } = await fixedCode(env, E, "12345678", t0);
    expect(
      await v(requestId, "12345678", {
        now: t0 + CODE_POLICY.ttlSec * 1000 + 1,
      }),
    ).toEqual({
      ok: false,
    });
  });

  it("H1: an attacker's request and wrong guesses don't kill the victim's pending code", async () => {
    const victim = await fixedCode(env, E, "12345678");
    const attacker = await fixedCode(env, E, "87654321");
    for (let i = 0; i < 5; i++)
      await v(attacker.requestId, "00000000", { ip: "192.0.2.66" });
    expect(await v(victim.requestId, "12345678", { ip: "192.0.2.1" })).toEqual({
      ok: true,
    });
  });

  it("H2: 60 parallel failures from one IP stop at exactly the cap, for that IP only", async () => {
    const ip = `192.0.2.${Math.floor(Math.random() * 200)}`;
    const rs = await Promise.all(
      Array.from({ length: 60 }, () =>
        v("no-such-request", "00000000", { ip }),
      ),
    );
    expect(rs.filter((r) => "ipLocked" in r)).toHaveLength(
      60 - CODE_LIMITS.failsPerIpPerHour,
    );
    expect(await counter(`code:fail:${await ipKey(env, ip)}`)).toBe(
      CODE_LIMITS.failsPerIpPerHour,
    );
    const { requestId } = await fixedCode(env, E, "12345678");
    expect(await v(requestId, "12345678", { ip: "192.0.2.250" })).toEqual({
      ok: true,
    });
  });

  it("a success refunds the reserved failure slot", async () => {
    const ip = "192.0.2.251";
    const { requestId } = await fixedCode(env, E, "12345678");
    await v(requestId, "12345678", { ip });
    expect(await counter(`code:fail:${await ipKey(env, ip)}`)).toBe(0);
  });

  it("the same statements run with and without a row", async () => {
    const seen: string[] = [];
    // A fresh proxy per run: prepared statements are cached per D1 binding.
    const recording = () =>
      new Proxy(env.DB, {
        get(t, k) {
          if (k === "prepare")
            return (sql: string) => {
              seen.push(sql.replace(/\s+/g, " ").trim());
              return t.prepare(sql);
            };
          const val = Reflect.get(t, k);
          return typeof val === "function" ? val.bind(t) : val;
        },
      });
    const seq = async (rid: string) => {
      seen.length = 0;
      await verifyCode({ ...env, DB: recording() } as Env, cfg, {
        email: E,
        requestId: rid,
        input: "00000000",
        ip: "192.0.2.252",
      });
      return [...seen];
    };
    const { requestId } = await fixedCode(env, E, "12345678");
    const withRow = await seq(requestId);
    const without = await seq("no-such-request");
    expect(withRow.length).toBeGreaterThan(0);
    expect(without).toEqual(withRow);
  });

  it("a code from install A does not verify on install B", async () => {
    const { requestId, ek } = await fixedCode(env, E, "12345678");
    const envB = { ...env, SESSION_SECRET: "z".repeat(32) } as Env;
    const ekB = await emailKey(envB, E);
    await env.DB.prepare(
      "insert into login_codes (email_key, request_id, code_hash, expires_at, created_at) select ?, request_id, code_hash, expires_at, created_at from login_codes where email_key = ? and request_id = ?",
    )
      .bind(ekB, ek, requestId)
      .run();
    expect(
      await verifyCode(envB, authConfig(envB), {
        email: E,
        requestId,
        input: "12345678",
        ip: IP,
      }),
    ).toEqual({ ok: false });
  });
});

describe("request throttles", () => {
  it("count ineligible addresses too, never with plaintext keys, (address, IP) first", async () => {
    const ek = await emailKey(env, uniq("nobody", "x.com"));
    const ik = await ipKey(env, "192.0.2.10");
    for (let i = 0; i < CODE_LIMITS.perEmailIpPer10Min; i++)
      expect(await takeRequestSlot(env, cfg, ek, ik)).toEqual({ ok: true });
    expect(await takeRequestSlot(env, cfg, ek, ik)).toMatchObject({
      ok: false,
      scope: "email",
    });
    const keys = (
      await env.DB.prepare(
        "select key from counters where key like 'code:%'",
      ).all<{ key: string }>()
    ).results.map((r) => r.key);
    expect(keys.some((k) => k.includes("@"))).toBe(false);
  });

  it("per address: code_abuse logged at 10, refused at 30, across IPs", async () => {
    const ek = await emailKey(env, uniq("target", "x.com"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < CODE_LIMITS.perEmailPerHour; i++)
      expect(await takeRequestSlot(env, cfg, ek, `ik-${i}`)).toEqual({
        ok: true,
      });
    expect(await takeRequestSlot(env, cfg, ek, "ik-x")).toMatchObject({
      ok: false,
      scope: "email",
    });
    const abuse = warn.mock.calls.filter((c) =>
      String(c[0]).includes("code_abuse"),
    );
    expect(abuse).toHaveLength(1);
    warn.mockRestore();
  });

  it("one IP's 31 requests for one address don't consume that address's other buckets", async () => {
    const ek = await emailKey(env, uniq("victim", "x.com"));
    const ik = await ipKey(env, "192.0.2.20");
    for (let i = 0; i < 31; i++) await takeRequestSlot(env, cfg, ek, ik);
    expect(await counter(`code:eip:${ek}:${ik}`)).toBe(
      CODE_LIMITS.perEmailIpPer10Min,
    );
    expect(await counter(`code:e:${ek}`)).toBe(CODE_LIMITS.perEmailIpPer10Min);
    expect(await counter(`code:ip:${ik}`)).toBe(CODE_LIMITS.perEmailIpPer10Min);
    // The address is still reachable from elsewhere.
    expect(
      await takeRequestSlot(env, cfg, ek, await ipKey(env, "192.0.2.21")),
    ).toEqual({ ok: true });
  });

  it("an IP over its day cap consumes no per-address bucket", async () => {
    const ik = await ipKey(env, "192.0.2.22");
    await fillCounter(`code:ip:${ik}`, CODE_LIMITS.perIpPerDay - 30, "day");
    const eks: string[] = [];
    for (let i = 0; i < 31; i++) {
      const ek = await emailKey(env, uniq(`other${i}`, "x.com"));
      eks.push(ek);
      await takeRequestSlot(env, cfg, ek, ik);
    }
    expect(await counter(`code:ip:${ik}`)).toBe(CODE_LIMITS.perIpPerDay);
    const last = eks[30] as string;
    expect(await counter(`code:e:${last}`)).toBe(0);
    expect(await counter(`code:eip:${last}:${ik}`)).toBe(0);
  });

  it("IPv6 keys by /64; IPv4 by the whole address", async () => {
    expect(await ipKey(env, "2001:db8:a:b:1::1")).toBe(
      await ipKey(env, "2001:0db8:000a:000b:ffff:ffff:ffff:ffff"),
    );
    expect(await ipKey(env, "2001:db8:a:b::1")).not.toBe(
      await ipKey(env, "2001:db8:a:c::1"),
    );
    expect(await ipKey(env, "192.0.2.1")).not.toBe(
      await ipKey(env, "192.0.2.2"),
    );
  });

  it("per IP: 50 a day", async () => {
    const ik = await ipKey(env, "192.0.2.11");
    await fillCounter(`code:ip:${ik}`, CODE_LIMITS.perIpPerDay, "day");
    const r = await takeRequestSlot(env, cfg, await emailKey(env, E), ik);
    expect(r).toMatchObject({ ok: false, scope: "ip" });
    if (!r.ok) expect(r.retryAfter).toBeGreaterThan(0);
  });
});

describe("deliverCode", () => {
  it("sends an eligible guest a code it can verify", async () => {
    await seedUser(E, "guest");
    const m = mailer();
    const e = withMail(direct(), m);
    const ek = await emailKey(e, E);
    expect(await deliverCode(e, authConfig(e), E, ek, "rid-1", IP)).toEqual({
      requestId: "rid-1",
    });
    expect(m.sent).toHaveLength(1);
    expect(
      await verifyCode(e, authConfig(e), {
        email: E,
        requestId: "rid-1",
        input: m.codeFor(E),
        ip: IP,
      }),
    ).toEqual({ ok: true });
  });

  it("ineligible addresses get no row, no email, no pool slot (N1)", async () => {
    const m = mailer();
    const e = withMail(direct(), m);
    const before = await counter("code:*");
    for (let i = 0; i < 20; i++) {
      const addr = uniq(`rnd${i}`, "x.com");
      expect(
        await deliverCode(
          e,
          authConfig(e),
          addr,
          await emailKey(e, addr),
          `r${i}`,
          IP,
        ),
      ).toBeNull();
    }
    expect(m.sent).toHaveLength(0);
    expect(await counter("code:*")).toBe(before);
  });

  it("H1: at most 5 real sends per address per hour", async () => {
    await seedUser(E, "guest");
    const m = mailer();
    const e = withMail(direct(), m);
    const ek = await emailKey(e, E);
    const t0 = hourStart(1);
    for (let i = 0; i < CODE_LIMITS.sendsPerEmailPerHour; i++)
      expect(
        await deliverCode(
          e,
          authConfig(e),
          E,
          ek,
          `s${i}`,
          `198.51.${i}.1`,
          t0 + i * 61_000,
        ),
      ).not.toBeNull();
    expect(
      await deliverCode(
        e,
        authConfig(e),
        E,
        ek,
        "s-over",
        "198.51.99.1",
        t0 + 600_000,
      ),
    ).toBeNull();
    expect(m.sent).toHaveLength(CODE_LIMITS.sendsPerEmailPerHour);
  });

  it("at most 10 real sends per address per day, across hours and networks", async () => {
    await seedUser(E, "guest");
    const m = mailer();
    const e = withMail(direct(), m);
    const ek = await emailKey(e, E);
    const sendAt = (i: number) =>
      deliverCode(
        e,
        authConfig(e),
        E,
        ek,
        `d${i}`,
        `198.51.${i}.1`,
        hourStart(2 + Math.floor(i / 5)) + (i % 5) * 61_000,
      );
    for (let i = 0; i < CODE_LIMITS.sendsPerEmailPerDay; i++)
      expect(await sendAt(i)).not.toBeNull();
    expect(await sendAt(CODE_LIMITS.sendsPerEmailPerDay)).toBeNull();
    expect(m.sent).toHaveLength(CODE_LIMITS.sendsPerEmailPerDay);
  });

  it("at most 5 sends per (address, IPv4 /24) and (address, IPv6 /64) per day", async () => {
    await seedUser(E, "guest");
    const m = mailer();
    const e = withMail(direct(), m);
    const ek = await emailKey(e, E);
    const at = (h: number, i: number) => hourStart(h) + i * 61_000;
    for (let i = 0; i < CODE_LIMITS.sendsPerEmailNetPerDay; i++)
      expect(
        await deliverCode(
          e,
          authConfig(e),
          E,
          ek,
          `n${i}`,
          `198.51.100.${i + 1}`,
          at(3, i),
        ),
      ).not.toBeNull();
    expect(
      await deliverCode(
        e,
        authConfig(e),
        E,
        ek,
        "n-over",
        "198.51.100.200",
        at(4, 0),
      ),
    ).toBeNull();
    // Another /24 still gets one.
    expect(
      await deliverCode(
        e,
        authConfig(e),
        E,
        ek,
        "n-other",
        "198.51.101.1",
        at(4, 1),
      ),
    ).not.toBeNull();

    const F = uniq("g6", "x.com");
    await seedUser(F, "guest");
    const fk = await emailKey(e, F);
    for (let i = 0; i < CODE_LIMITS.sendsPerEmailNetPerDay; i++)
      expect(
        await deliverCode(
          e,
          authConfig(e),
          F,
          fk,
          `v${i}`,
          `2001:db8:1:2::${i + 1}`,
          at(3, i),
        ),
      ).not.toBeNull();
    expect(
      await deliverCode(
        e,
        authConfig(e),
        F,
        fk,
        "v-over",
        "2001:db8:1:2:ffff::9",
        at(4, 0),
      ),
    ).toBeNull();
    expect(
      await deliverCode(
        e,
        authConfig(e),
        F,
        fk,
        "v-other",
        "2001:db8:1:3::1",
        at(4, 1),
      ),
    ).not.toBeNull();
  });

  it("a second send inside 60 s isn't delivered (and frees its cap slots)", async () => {
    await seedUser(E, "guest");
    const m = mailer();
    const e = withMail(direct(), m);
    const ek = await emailKey(e, E);
    const t0 = hourStart(5);
    expect(
      await deliverCode(e, authConfig(e), E, ek, "rs1", IP, t0),
    ).not.toBeNull();
    expect(
      await deliverCode(e, authConfig(e), E, ek, "rs2", IP, t0 + 59_000),
    ).toBeNull();
    expect(m.sent).toHaveLength(1);
    expect(await counter(`code:sent:${ek}`)).toBe(1);
    expect(
      await one("select 1 from login_codes where request_id = 'rs2'"),
    ).toBeNull();
    expect(
      await deliverCode(e, authConfig(e), E, ek, "rs3", IP, t0 + 60_000),
    ).not.toBeNull();
    expect(m.sent).toHaveLength(2);
  });

  it("a full code pool sends nothing", async () => {
    await seedUser(E, "guest");
    const m = mailer();
    const e = withMail(direct({ CODE_EMAILS_PER_DAY: "3" }), m);
    await fillCounter("code:*", 3, "day");
    expect(
      await deliverCode(e, authConfig(e), E, await emailKey(e, E), "p1", IP),
    ).toBeNull();
    expect(m.sent).toHaveLength(0);
    await fillCounter("code:*", 0, "day");
  });

  it("a full invite pool does not block codes (separate pools)", async () => {
    await seedUser(E, "guest");
    const m = mailer();
    const e = withMail(direct({ EMAIL_DAILY_CAP: "1" }), m);
    await fillCounter("email:*", 1, "day");
    expect(
      await deliverCode(e, authConfig(e), E, await emailKey(e, E), "sep", IP),
    ).not.toBeNull();
    await fillCounter("email:*", 0, "day");
  });

  it("a failed send leaves no usable code", async () => {
    await seedUser(E, "guest");
    const e = withMail(direct(), mailer(true));
    const ek = await emailKey(e, E);
    expect(await deliverCode(e, authConfig(e), E, ek, "fail-1", IP)).toBeNull();
    expect(
      await one("select 1 from login_codes where request_id = 'fail-1'"),
    ).toBeNull();
  });

  it("email off: nothing sent, no row", async () => {
    await seedUser(E, "guest");
    const ek = await emailKey(env, E);
    expect(await deliverCode(direct(), cfg, E, ek, "off-1", IP)).toBeNull();
    expect(
      await one("select 1 from login_codes where request_id = 'off-1'"),
    ).toBeNull();
  });

  it("trial: a domain member gets a code; with Google on they don't", async () => {
    const addr = uniq("own");
    await seedUser(addr, "owner");
    const m = mailer();
    const e = withMail(trial(), m);
    expect(
      await deliverCode(
        e,
        authConfig(e),
        addr,
        await emailKey(e, addr),
        "t1",
        IP,
      ),
    ).not.toBeNull();
    const g = withMail(direct(), m);
    expect(
      await deliverCode(
        g,
        authConfig(g),
        addr,
        await emailKey(g, addr),
        "t2",
        IP,
      ),
    ).toBeNull();
  });

  it("logs never contain the email or the code", async () => {
    await seedUser(E, "guest");
    const lines: string[] = [];
    const spies = (["log", "warn", "error"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(" "));
      }),
    );
    const m = mailer();
    const e = withMail(direct(), m);
    const ek = await emailKey(e, E);
    await deliverCode(e, authConfig(e), E, ek, "log-1", IP);
    const code = m.codeFor(E);
    await verifyCode(e, authConfig(e), {
      email: E,
      requestId: "log-1",
      input: "00000000",
      ip: IP,
    });
    await verifyCode(e, authConfig(e), {
      email: E,
      requestId: "log-1",
      input: code,
      ip: IP,
    });
    for (const s of spies) s.mockRestore();
    const text = lines.join("\n");
    expect(text).not.toContain(E);
    expect(text).not.toContain(code);
  });
});

describe("email pools", () => {
  it("EMAIL_DAILY_CAP replaces the hard-coded invite cap", async () => {
    expect(emailDailyCap(env)).toBe(100);
    expect(emailDailyCap({ ...env, EMAIL_DAILY_CAP: "3" } as Env)).toBe(3);
    for (const v of [undefined, "", "0", "abc", "100001"])
      expect(emailDailyCap({ ...env, EMAIL_DAILY_CAP: v } as Env)).toBe(100);
  });

  it("invites stop at EMAIL_DAILY_CAP", async () => {
    const m = mailer();
    const e = withMail(env, m);
    const cap = { ...e, EMAIL_DAILY_CAP: "2" } as Env;
    await fillCounter("email:*", 0, "day");
    const owner = await login(uniq("inv"), "owner");
    const inviter = {
      id: owner.userId,
      email: "inv@a.com",
      name: "Inv",
      role: "owner",
    } as never;
    const res = [];
    for (let i = 0; i < 3; i++)
      res.push(
        (
          await inviteMember(cap, inviter, {
            email: uniq(`n${i}`),
            role: "member",
          })
        ).emailed,
      );
    expect(res).toEqual([true, true, false]);
    await fillCounter("email:*", 0, "day");
  });
});

describe("loginCodeEmail", () => {
  it("shows the code as 1234 5678 with the expiry; no link carries it; no em dash", () => {
    const m = loginCodeEmail({
      code: "12345678",
      instance: "Acme",
      appHost: "a.test",
      minutes: 10,
    });
    for (const part of [m.text, m.html]) {
      expect(part).toContain("1234 5678");
      expect(part).toContain("10 minutes");
      expect(part).not.toContain("—");
    }
    expect(m.html).not.toMatch(/href="[^"]*1234/);
    expect(m.subject).not.toContain("1234");
  });

  it("escapes the instance name", () => {
    const m = loginCodeEmail({
      code: "12345678",
      instance: "<b>x</b>",
      appHost: "a.test",
      minutes: 10,
    });
    expect(m.html).not.toContain("<b>x</b>");
  });
});

describe("a SESSION_SECRET under 32 characters", () => {
  // HKDF needs 32+ bytes, so codes can't be keyed on such an install: 503
  // code_unavailable, never a 500 on every code request.
  const short = () => direct({ SESSION_SECRET: "s".repeat(20) });

  it("emailKey and ipKey refuse with code_unavailable", async () => {
    const e = short();
    for (const run of [
      () => emailKey(e, "g@x.com"),
      () => ipKey(e, "203.0.113.1"),
    ])
      await expect(run()).rejects.toMatchObject({
        name: "ApiError",
        code: "code_unavailable",
      });
  });

  it("deliverCode sends nothing and writes no row", async () => {
    const m = mailer();
    const e = { ...short(), ...m.env } as Env;
    await seedUser("g@x.com", "guest");
    await expect(
      deliverCode(e, authConfig(e), "g@x.com", "ek", "rid", IP),
    ).rejects.toMatchObject({ code: "code_unavailable" });
    expect(m.sent).toHaveLength(0);
    expect(
      (
        await one<{ n: number }>(
          "select count(*) n from login_codes where request_id = 'rid'",
        )
      )?.n,
    ).toBe(0);
  });
});
