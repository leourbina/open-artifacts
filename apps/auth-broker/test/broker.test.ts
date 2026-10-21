import { env } from "cloudflare:workers";
import {
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_TOKEN_URL,
  keyId,
  publicFromPkcs8,
  signRedeem,
} from "@oa/auth-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import broker from "../src/index.js";
import { clearRegistryCache } from "../src/registry.js";

const BROKER = "https://auth.hosted.test";
const pk = (fill: number) =>
  Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.alloc(32, fill),
  ]).toString("base64url");
const KEY_A = pk(1);
const KEY_B = pk(2);
const KEY_A2 = pk(3);

type Entry = {
  installId: string;
  origin: string;
  keys: { kid: string; x: string }[];
  domains?: string[];
  disabled?: boolean;
};
async function entryFor(
  id: string,
  origin: string,
  ...keys: string[]
): Promise<Entry> {
  const out = [];
  for (const k of keys) {
    const x = await publicFromPkcs8(k);
    out.push({ kid: await keyId(x), x });
  }
  return { installId: id, origin, keys: out, domains: ["a.com"] };
}
const put = (e: Entry) =>
  env.BROKER_REGISTRY.put(`install:${e.installId}`, JSON.stringify(e));

const call = (path: string, init?: RequestInit) =>
  broker.fetch(new Request(`${BROKER}${path}`, init) as never, env);

let tokenCalls: URLSearchParams[] = [];
let tokenReply: () => Response = () =>
  Response.json({ id_token: "raw.google.token" });
beforeEach(async () => {
  clearRegistryCache();
  tokenCalls = [];
  tokenReply = () => Response.json({ id_token: "raw.google.token" });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.url === GOOGLE_TOKEN_URL) {
      tokenCalls.push(new URLSearchParams(await req.text()));
      return tokenReply();
    }
    throw new Error(`unexpected fetch ${req.url}`);
  });
  await put(await entryFor("inst-a", "https://a.hosted.test", KEY_A));
  await put(await entryFor("inst-b", "https://b.hosted.test", KEY_B));
  await put({
    ...(await entryFor("inst-off", "https://off.hosted.test", KEY_A)),
    disabled: true,
  });
});
afterEach(() => vi.restoreAllMocks());

async function redeem(
  key: string,
  body: Record<string, unknown>,
  o: { kid?: string; tamper?: boolean } = {},
) {
  const text = JSON.stringify({
    install: "inst-a",
    code: "c",
    verifier: "v",
    ts: Date.now(),
    ...body,
  });
  const sig = await signRedeem(key, text);
  return call("/google/redeem", {
    method: "POST",
    headers: {
      "x-oa-kid": o.kid ?? (await keyId(await publicFromPkcs8(key))),
      "x-oa-sig": sig,
      "content-type": "application/json",
    },
    body: o.tamper ? text.replace('"c"', '"d"') : text,
  });
}

describe("authorize", () => {
  it("sends the user to Google with the install's nonce and challenge and a signed broker state", async () => {
    const r = await call(
      "/google/authorize?install=inst-a&state=s1&nonce=n1&code_challenge=ch1",
    );
    expect(r.status).toBe(302);
    const u = new URL(r.headers.get("location") ?? "");
    expect(`${u.origin}${u.pathname}`).toBe(GOOGLE_AUTHORIZE_URL);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: `${BROKER}/google/callback`,
      nonce: "n1",
      code_challenge: "ch1",
      code_challenge_method: "S256",
      prompt: "select_account",
      hd: "a.com",
    });
    expect(u.searchParams.get("state")).not.toBe("s1");
  });

  it("unknown or disabled installs and missing params are 404", async () => {
    for (const q of [
      "install=nope&state=s&nonce=n&code_challenge=c",
      "install=inst-off&state=s&nonce=n&code_challenge=c",
      "install=inst-a&state=s&nonce=n",
    ])
      expect((await call(`/google/authorize?${q}`)).status).toBe(404);
  });
});

describe("callback", () => {
  const bstate = async (install = "inst-a") => {
    const r = await call(
      `/google/authorize?install=${install}&state=s1&nonce=n&code_challenge=c`,
    );
    return (
      new URL(r.headers.get("location") ?? "").searchParams.get("state") ?? ""
    );
  };

  it("relays the code to the registry origin only, with the install's own state", async () => {
    const r = await call(
      `/google/callback?code=abc&state=${encodeURIComponent(await bstate())}`,
    );
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(
      "https://a.hosted.test/auth/callback/google?code=abc&state=s1",
    );
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("a broker state with the install swapped (or any tampering) is refused", async () => {
    const st = await bstate();
    const [p, sig] = st.split(".");
    const body = JSON.parse(Buffer.from(p as string, "base64url").toString());
    const swapped = Buffer.from(
      JSON.stringify({ ...body, i: "inst-b" }),
    ).toString("base64url");
    for (const s of [`${swapped}.${sig}`, `${p}.${sig}x`, "garbage", ""])
      expect(
        (await call(`/google/callback?code=abc&state=${encodeURIComponent(s)}`))
          .status,
      ).toBe(404);
  });

  it("a Google error goes back to the install as an error, still to the registry origin", async () => {
    const r = await call(
      `/google/callback?error=access_denied&state=${encodeURIComponent(await bstate())}`,
    );
    expect(r.headers.get("location")).toBe(
      "https://a.hosted.test/auth/callback/google?error=access_denied&state=s1",
    );
  });
});

describe("redeem", () => {
  it("returns Google's ID token unchanged; the code goes with the broker callback and the verifier", async () => {
    const r = await redeem(KEY_A, {
      code: "the-code",
      verifier: "the-verifier",
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id_token: "raw.google.token" });
    expect(Object.fromEntries(tokenCalls[0] ?? [])).toMatchObject({
      code: "the-code",
      code_verifier: "the-verifier",
      redirect_uri: `${BROKER}/google/callback`,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    });
  });

  it("A's key signing a redeem for install B is refused, with no Google call", async () => {
    expect((await redeem(KEY_A, { install: "inst-b" })).status).toBe(401);
    expect(tokenCalls).toHaveLength(0);
  });

  it("unknown kid, bad signature, stale ts, disabled install, garbage: 401 and no Google call", async () => {
    for (const r of [
      await redeem(KEY_A, {}, { kid: "nope" }),
      await redeem(KEY_A, {}, { tamper: true }),
      await redeem(KEY_A, { ts: Date.now() - 61_000 }),
      await redeem(KEY_A, { ts: Date.now() + 61_000 }),
      await redeem(KEY_A, { install: "inst-off" }),
      await call("/google/redeem", { method: "POST", body: "{" }),
    ])
      expect(r.status).toBe(401);
    expect(tokenCalls).toHaveLength(0);
  });

  it("a stored kid that doesn't derive from its key (N3) is refused", async () => {
    const e = await entryFor("inst-a", "https://a.hosted.test", KEY_A);
    await put({
      ...e,
      keys: [{ kid: "wrong-kid-000000", x: e.keys[0]?.x as string }],
    });
    clearRegistryCache();
    expect((await redeem(KEY_A, {}, { kid: "wrong-kid-000000" })).status).toBe(
      401,
    );
  });

  it("rotation: both active keys work; a removed key fails", async () => {
    await put(await entryFor("inst-a", "https://a.hosted.test", KEY_A, KEY_A2));
    clearRegistryCache();
    expect((await redeem(KEY_A, {})).status).toBe(200);
    expect((await redeem(KEY_A2, {})).status).toBe(200);
    await put(await entryFor("inst-a", "https://a.hosted.test", KEY_A2));
    clearRegistryCache();
    expect((await redeem(KEY_A, {})).status).toBe(401);
  });

  it("a failed exchange is 400 exchange_failed", async () => {
    tokenReply = () =>
      Response.json({ error: "invalid_grant" }, { status: 400 });
    const r = await redeem(KEY_A, {});
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "exchange_failed" });
  });

  it("the registry holds no secret material", async () => {
    const raw = (await env.BROKER_REGISTRY.get(
      "install:inst-a",
      "json",
    )) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual([
      "domains",
      "installId",
      "keys",
      "origin",
    ]);
    for (const k of raw.keys as Record<string, unknown>[])
      expect(Object.keys(k).sort()).toEqual(["kid", "x"]);
  });

  it("logs never contain the code, verifier, token or keys", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: unknown) => {
      lines.push(String(s));
    });
    await redeem(KEY_A, { code: "secret-code", verifier: "secret-verifier" });
    await redeem(KEY_A, { install: "inst-b", code: "secret-code" });
    const all = lines.join("\n");
    for (const s of [
      "secret-code",
      "secret-verifier",
      "raw.google.token",
      KEY_A,
      env.GOOGLE_CLIENT_SECRET,
    ])
      expect(all).not.toContain(s);
  });
});
