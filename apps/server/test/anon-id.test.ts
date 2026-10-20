import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  ANON_ID_HEADER,
  AnonViewerSchema,
  DataDocSchema,
  LIMITS,
  type Member,
  newId,
  R,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resolveAnonId } from "../src/runtime/anon-id.js";
import {
  type ArtifactRuntime,
  anonWritesPerMin,
  publicActor,
  runtimeStub,
} from "../src/runtime/do.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
let owner: { cookie: string; member: Member };
const TOKEN_RE = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const BY_RE = /^anon:[A-Za-z0-9_-]{8}$/;

beforeAll(async () => {
  const l = await login(`anonid-${tag}@x.com`, "member");
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  owner = { cookie: l.cookie, member: m };
});

const pub = async (extra: Record<string, unknown>) =>
  (
    await publish(
      env,
      owner.member,
      {
        title: "game",
        format: "html",
        content: "<p>hi</p>",
        capabilities: { db: true, viewer: true, storage: true },
        ...extra,
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;
const optIn = () => pub({ visibility: "public", allowAnonymousWrites: true });

let ipSeq = 0;
const uniqueIp = () =>
  `198.18.${Math.floor(Math.random() * 256)}.${(++ipSeq % 254) + 1}`;

/** Anonymous call (a fresh IP each, unless given) carrying `token`, if any. */
const anon = (
  path: string,
  token: string | null,
  init: { method?: string; body?: unknown; ip?: string } = {},
) =>
  api(app, path, null, {
    ...init,
    headers: {
      "cf-connecting-ip": init.ip ?? uniqueIp(),
      ...(token ? { [ANON_ID_HEADER]: token } : {}),
    },
  });
const write = (id: string, doc: string, token: string | null, ip?: string) =>
  anon(R.dataDoc(id, "c", doc), token, { method: "PUT", body: 1, ip });
const byOf = async (r: Response) =>
  DataDocSchema.parse(await r.json()).updatedBy;

describe("anonId issuance", () => {
  it("is never issued on an artifact without allowAnonymousWrites", async () => {
    const id = await pub({ visibility: "public" });
    const r = await anon(R.dataCollection(id, "c"), null);
    expect(r.status).toBe(200);
    expect(r.headers.get(ANON_ID_HEADER)).toBeNull();
    expect((await anon(R.anonId(id), null)).status).toBe(401);
    // A valid token from elsewhere is ignored, not echoed.
    const { issued } = await resolveAnonId(env, undefined);
    const r2 = await anon(R.dataCollection(id, "c"), issued);
    expect(r2.headers.get(ANON_ID_HEADER)).toBeNull();
  });

  it("is minted on the first anonymous read, then stable across calls", async () => {
    const id = await optIn();
    const first = await anon(R.dataCollection(id, "c"), null);
    expect(first.status).toBe(200);
    const token = first.headers.get(ANON_ID_HEADER) ?? "";
    expect(token).toMatch(TOKEN_RE);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const short = token.slice(0, 8);

    const w1 = await write(id, "a", token);
    expect(w1.headers.get(ANON_ID_HEADER)).toBeNull();
    expect(await byOf(w1)).toBe(`anon:${short}`);
    // Another IP, same browser: same id.
    const w2 = await anon(R.dataDoc(id, "c", "b"), token, {
      method: "PATCH",
      body: { x: 1 },
    });
    expect(await byOf(w2)).toBe(`anon:${short}`);
    const g = await anon(R.dataDoc(id, "c", "a"), token);
    expect(await byOf(g)).toBe(`anon:${short}`);
    const me = await anon(R.anonId(id), token);
    expect(AnonViewerSchema.parse(await me.json())).toEqual({ anonId: short });
    expect(me.headers.get(ANON_ID_HEADER)).toBeNull();
  });

  it("a token-less write mints one and uses it", async () => {
    const id = await optIn();
    const w = await write(id, "a", null);
    expect(w.status).toBe(200);
    const token = w.headers.get(ANON_ID_HEADER) ?? "";
    expect(token).toMatch(TOKEN_RE);
    expect(await byOf(w)).toBe(`anon:${token.slice(0, 8)}`);
  });

  it("a forged or tampered token is never accepted: a new one is minted", async () => {
    const id = await optIn();
    const good = (await resolveAnonId(env, undefined)).issued ?? "";
    const [gid = "", gsig = ""] = good.split(".");
    const flip = (s: string, i: number) =>
      s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
    const forged = [
      `${flip(gid, 0)}.${gsig}`, // claims another id
      `${gid}.${flip(gsig, 5)}`, // bad signature
      `${gid}.${"A".repeat(43)}`,
      `${gid}`,
      `${gid}.${gsig}x`,
      "garbage",
      `${gid}..${gsig}`,
      `${gsig}.${gid}`,
    ];
    for (const f of forged) {
      const w = await write(id, "f", f);
      expect(w.status).toBe(200);
      const fresh = w.headers.get(ANON_ID_HEADER) ?? "";
      expect(fresh).toMatch(TOKEN_RE);
      expect(fresh).not.toBe(f);
      expect(fresh.slice(0, 8)).not.toBe(gid.slice(0, 8));
      expect(await byOf(w)).toBe(`anon:${fresh.slice(0, 8)}`);
    }
    // A token signed with another key is refused too.
    const other = await resolveAnonId(
      { SESSION_SECRET: "x".repeat(40) },
      undefined,
    );
    const w = await write(id, "g", other.issued);
    expect(w.headers.get(ANON_ID_HEADER)).not.toBe(other.issued);
    expect(await byOf(w)).not.toBe(`anon:${other.short}`);
  });

  it("two browsers get distinct ids", async () => {
    const id = await optIn();
    const a = (await anon(R.dataCollection(id, "c"), null)).headers.get(
      ANON_ID_HEADER,
    );
    const b = (await anon(R.dataCollection(id, "c"), null)).headers.get(
      ANON_ID_HEADER,
    );
    expect(a).toMatch(TOKEN_RE);
    expect(b).toMatch(TOKEN_RE);
    expect(a?.slice(0, 22)).not.toBe(b?.slice(0, 22));
    const wa = await write(id, "a", a);
    const wb = await write(id, "b", b);
    const [ba, bb] = [await byOf(wa), await byOf(wb)];
    expect(ba).not.toBe(bb);
    expect(ba).toMatch(BY_RE);
    expect(bb).toMatch(BY_RE);
  });

  it("signed-in callers are unchanged: no token, updatedBy u:{id}", async () => {
    const id = await optIn();
    const { issued } = await resolveAnonId(env, undefined);
    const r = await api(app, R.dataDoc(id, "c", "s"), owner.cookie, {
      method: "PUT",
      body: 1,
      headers: { [ANON_ID_HEADER]: issued ?? "" },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get(ANON_ID_HEADER)).toBeNull();
    expect(await byOf(r)).toBe(`u:${owner.member.id}`);
    expect((await api(app, R.anonId(id), owner.cookie)).status).toBe(401);
  });

  it("anonymous subscribe and storage never mint", async () => {
    const id = await optIn();
    const s = await anon(R.storageKey(id, "k"), null);
    expect(s.status).toBe(401);
    expect(s.headers.get(ANON_ID_HEADER)).toBeNull();
  });
});

describe("publicActor", () => {
  it("maps anonymous actors to anon / anon:{short}", () => {
    expect(publicActor("ip:1.2.3.4")).toBe("anon");
    expect(publicActor("ip:1.2.3.4|AbCd_-12")).toBe("anon:AbCd_-12");
    expect(publicActor("ip:2001:db8:1:2::/64|AbCd_-12")).toBe("anon:AbCd_-12");
    expect(publicActor("ip:1.2.3.4|short")).toBe("anon");
    expect(publicActor("u:abc")).toBe("u:abc");
  });
});

describe("ANON_WRITES_PER_MIN", () => {
  it("defaults to LIMITS.anonWritesPerMinPerIp and clamps to 1..600", () => {
    expect(anonWritesPerMin(undefined)).toBe(LIMITS.anonWritesPerMinPerIp);
    expect(anonWritesPerMin("")).toBe(LIMITS.anonWritesPerMinPerIp);
    expect(anonWritesPerMin("abc")).toBe(LIMITS.anonWritesPerMinPerIp);
    expect(anonWritesPerMin("-5")).toBe(LIMITS.anonWritesPerMinPerIp);
    expect(anonWritesPerMin("2.5")).toBe(LIMITS.anonWritesPerMinPerIp);
    expect(anonWritesPerMin("0")).toBe(1);
    expect(anonWritesPerMin("45")).toBe(45);
    expect(anonWritesPerMin(" 45 ")).toBe(45);
    expect(anonWritesPerMin("600")).toBe(600);
    expect(anonWritesPerMin("100000")).toBe(600);
  });

  it("the DO applies it per IP, across anonIds", async () => {
    const id = await optIn();
    await runInDurableObject(
      runtimeStub(env, id) as unknown as DurableObjectStub<ArtifactRuntime>,
      (i) => {
        i.now = () => Date.UTC(2026, 0, 1, 12, 0, 30);
        (i as unknown as { env: object }).env = {
          ...(i as unknown as { env: object }).env,
          ANON_WRITES_PER_MIN: "3",
        };
      },
    );
    const ip = uniqueIp();
    for (let n = 0; n < 3; n++)
      expect((await write(id, `d${n}`, null, ip)).status).toBe(200);
    // A fresh anonId from the same IP doesn't reset the per-IP count.
    const r = await write(id, "x", null, ip);
    expect(r.status).toBe(429);
    expect((await write(id, "y", null, uniqueIp())).status).toBe(200);
  });
});
