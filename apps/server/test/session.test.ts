import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  readSession,
  sessionCookie,
  sessionCookieName,
  signSession,
} from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { b64urlEncode, hmacSign } from "../src/util/crypto.js";

const UID = "abcdefghjkmnpqrs";
const now = 1_700_000_000_000;
const WEEK = 7 * 86400 * 1000;

describe("session", () => {
  it("round-trips", async () => {
    const v = await signSession(env, UID, now);
    expect(await readSession(env, v, now + 1000)).toEqual({
      uid: UID,
      exp: now + WEEK,
      iat: now,
      p: "access",
      e: 0,
    });
  });
  it("rejects expired", async () => {
    const v = await signSession(env, UID, now);
    expect(await readSession(env, v, now + WEEK)).toBeNull();
  });
  it("rejects tampered payload", async () => {
    const v = await signSession(env, UID, now);
    const [p, s] = v.split(".");
    const bad = `${p?.slice(0, -1)}${p?.endsWith("A") ? "B" : "A"}.${s}`;
    expect(await readSession(env, bad, now)).toBeNull();
  });
  it("rejects other secret", async () => {
    const v = await signSession(
      { SESSION_SECRET: "other-secret-0123456789abcdefghijkl" } as Env,
      UID,
      now,
    );
    expect(await readSession(env, v, now)).toBeNull();
  });
  it("rejects garbage, undefined, oversized", async () => {
    expect(await readSession(env, undefined)).toBeNull();
    expect(await readSession(env, "abc")).toBeNull();
    expect(await readSession(env, "a.b.c")).toBeNull();
    expect(await readSession(env, `${"a".repeat(2000)}.x`)).toBeNull();
  });
  it("cookie format", () => {
    expect(
      sessionCookie("v", {
        SESSION_SECRET: env.SESSION_SECRET,
        ENVIRONMENT: "production",
      } as Env),
    ).toBe(
      `__Host-${sessionCookieName(env)}=v; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`,
    );
    expect(
      sessionCookie("v", {
        SESSION_SECRET: env.SESSION_SECRET,
        ENVIRONMENT: "dev",
      } as Env),
    ).toBe(
      `${sessionCookieName(env)}=v; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`,
    );
  });
  it("signSession rejects a missing secret and a bad uid", async () => {
    await expect(
      signSession({ SESSION_SECRET: "" } as Env, UID, now),
    ).rejects.toThrow();
    await expect(signSession(env, "not-an-id", now)).rejects.toThrow();
  });
  it("readSession never throws on bad secret", async () => {
    const v = await signSession(env, UID, now);
    expect(await readSession({ SESSION_SECRET: "" } as Env, v, now)).toBeNull();
    expect(await readSession({} as Env, v, now)).toBeNull();
  });
  it("rejects validly signed payloads with bad shape", async () => {
    const mk = async (o: unknown) => {
      const p = b64urlEncode(new TextEncoder().encode(JSON.stringify(o)));
      return `${p}.${await hmacSign(env.SESSION_SECRET, p)}`;
    };
    for (const o of [
      null,
      {},
      { exp: now + 1000 },
      { uid: UID, exp: "9999999999999" },
      { uid: UID, exp: Number.NaN },
      { uid: "bad id", exp: now + 1000 },
      { uid: 5, exp: now + 1000 },
    ])
      expect(await readSession(env, await mk(o), now)).toBeNull();
    expect(
      await readSession(env, await mk({ uid: UID, exp: now + 1000 }), now),
    ).not.toBeNull();
  });
});
