// B3: the daily latest-release check and Me.instance.update.
import { env } from "cloudflare:workers";
import { MeSchema, newId, R } from "@oa/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { scheduled } from "../src/cron.js";
import {
  checkLatestRelease,
  instanceUpdate,
  parseSemver,
  RELEASE_API,
  RELEASE_KEY,
} from "../src/services/release.js";
import { api, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();

const stored = async () => {
  const r = await env.DB.prepare("select value from settings where key = ?")
    .bind(RELEASE_KEY)
    .first<{ value: string }>();
  return r ? JSON.parse(r.value) : null;
};
const release = (over: Record<string, unknown> = {}) =>
  Response.json({
    tag_name: "v0.4.0",
    published_at: "2026-10-19T12:00:00Z",
    html_url: "https://evil.example/x",
    draft: false,
    prerelease: false,
    body: "## Features\n* thing",
    ...over,
  });
const fetchOf = (f: () => Response | Promise<Response>) =>
  vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => f());

beforeEach(async () => {
  await env.DB.prepare("delete from settings where key = ?")
    .bind(RELEASE_KEY)
    .run();
});

describe("checkLatestRelease", () => {
  it("stores tag, version, publishedAt, url, breaking, checkedAt", async () => {
    const f = fetchOf(() => release());
    await checkLatestRelease(env, 1000, f as typeof fetch);
    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RELEASE_API);
    const h = new Headers(init.headers);
    expect(h.get("user-agent")).toMatch(/^open-artifacts\//);
    expect(h.get("authorization")).toBeNull();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(await stored()).toEqual({
      tag: "v0.4.0",
      version: "0.4.0",
      publishedAt: "2026-10-19T12:00:00Z",
      url: "https://github.com/open-artifacts-ai/open-artifacts/releases/tag/v0.4.0",
      breaking: false,
      checkedAt: 1000,
      checkError: null,
      errorAt: null,
    });
  });

  it("breaking: the body mentions BREAKING CHANGE", async () => {
    await checkLatestRelease(
      env,
      1,
      fetchOf(() =>
        release({ body: "### ⚠ BREAKING CHANGES\n* x" }),
      ) as typeof fetch,
    );
    expect((await stored()).breaking).toBe(true);
  });

  it.each([
    ["403", () => new Response("rate", { status: 403 }), "rate_limited"],
    ["429", () => new Response("rate", { status: 429 }), "rate_limited"],
    ["404", () => new Response("nf", { status: 404 }), "no_release"],
    ["500", () => new Response("x", { status: 500 }), "http_500"],
    ["bad JSON", () => new Response("{not json"), "bad_json"],
    ["non-semver tag", () => release({ tag_name: "nightly" }), "bad_tag"],
    ["prerelease", () => release({ prerelease: true }), "no_release"],
    [
      "network",
      () => {
        throw new TypeError("fetch failed");
      },
      "network",
    ],
  ] as const)(
    "%s keeps the last good value and records checkError",
    async (_n, f, code) => {
      await checkLatestRelease(
        env,
        1000,
        fetchOf(() => release()) as typeof fetch,
      );
      const good = await stored();
      const out = await checkLatestRelease(
        env,
        2000,
        fetchOf(f) as typeof fetch,
      );
      expect(out).not.toBeNull();
      expect(await stored()).toEqual({
        ...good,
        checkError: code,
        errorAt: 2000,
      });
    },
  );

  it("an error before any good check stores only the error", async () => {
    await checkLatestRelease(
      env,
      5,
      fetchOf(() => new Response("", { status: 429 })) as typeof fetch,
    );
    expect(await stored()).toEqual({ checkError: "rate_limited", errorAt: 5 });
  });

  it("never throws, even when D1 fails", async () => {
    const broken = { ...env, DB: undefined } as never;
    await expect(
      checkLatestRelease(broken, 1, fetchOf(() => release()) as typeof fetch),
    ).resolves.toBeNull();
  });

  it("runs from the daily cron", async () => {
    const f = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => release({ tag_name: "v9.9.9" }));
    try {
      const waits: Promise<unknown>[] = [];
      await scheduled({} as ScheduledController, env, {
        waitUntil: (p: Promise<unknown>) => waits.push(p),
        passThroughOnException() {},
      } as unknown as ExecutionContext);
      await Promise.all(waits);
      expect(f).toHaveBeenCalledWith(RELEASE_API, expect.anything());
      expect((await stored()).version).toBe("9.9.9");
    } finally {
      f.mockRestore();
    }
  });
});

describe("instanceUpdate (semver, custom builds)", () => {
  const raw = (version: string, breaking = false) =>
    JSON.stringify({
      tag: `v${version}`,
      version,
      url: `https://github.com/open-artifacts-ai/open-artifacts/releases/tag/v${version}`,
      breaking,
      checkedAt: Date.UTC(2026, 9, 20),
      checkError: null,
      errorAt: null,
    });

  it("parseSemver: plain X.Y.Z only", () => {
    expect(parseSemver("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("0.10.0")).toEqual([0, 10, 0]);
    expect(parseSemver("1.2.3-dev+abc")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("01.2.3")).toBeNull();
  });

  it.each([
    ["0.3.0", "0.4.0", true],
    ["0.3.0", "0.3.0", false],
    ["0.4.0", "0.3.9", false],
    ["0.9.0", "0.10.0", true],
    ["1.0.0", "0.99.99", false],
    ["0.3.1", "0.3.2", true],
  ])("current %s, latest %s -> updateAvailable %s", (cur, latest, want) => {
    const u = instanceUpdate("owner", raw(latest, true), cur);
    expect(u).toEqual({
      latestVersion: latest,
      current: cur,
      custom: false,
      updateAvailable: want,
      breaking: true,
      url: `https://github.com/open-artifacts-ai/open-artifacts/releases/tag/v${latest}`,
      checkedAt: "2026-10-20T00:00:00.000Z",
    });
  });

  it.each(["0.3.0-dev+abc1234", "0.3.0-dev", "0.2.0-rc.1"])(
    "%s is custom: updateAvailable false",
    (cur) => {
      expect(instanceUpdate("admin", raw("0.4.0"), cur)).toMatchObject({
        current: cur,
        custom: true,
        updateAvailable: false,
      });
    },
  );

  it("null for members and guests, before a good check, and for junk", () => {
    expect(instanceUpdate("member", raw("0.4.0"), "0.3.0")).toBeNull();
    expect(instanceUpdate("guest", raw("0.4.0"), "0.3.0")).toBeNull();
    expect(instanceUpdate("owner", undefined, "0.3.0")).toBeNull();
    expect(instanceUpdate("owner", "{bad", "0.3.0")).toBeNull();
    expect(
      instanceUpdate(
        "owner",
        JSON.stringify({ checkError: "rate_limited", errorAt: 1 }),
        "0.3.0",
      ),
    ).toBeNull();
  });
});

describe("Me.instance.update visibility", () => {
  it("owner and admin see it; member and guest get null", async () => {
    await checkLatestRelease(
      env,
      Date.now(),
      fetchOf(() => release()) as typeof fetch,
    );
    for (const [role, visible] of [
      ["owner", true],
      ["admin", true],
      ["member", false],
      ["guest", false],
    ] as const) {
      const u = await login(`rel-${role}-${tag}@x.com`, role);
      const r = await api(app, R.me, u.cookie);
      expect(r.status).toBe(200);
      const me = MeSchema.parse(await r.json());
      if (visible)
        expect(me.instance.update).toMatchObject({
          latestVersion: "0.4.0",
          breaking: false,
        });
      else expect(me.instance.update).toBeNull();
    }
  });

  it("null for admins before any check", async () => {
    const u = await login(`rel-none-${tag}@x.com`, "admin");
    const me = MeSchema.parse(await (await api(app, R.me, u.cookie)).json());
    expect(me.instance.update).toBeNull();
  });

  it("GET settings does not leak the release row", async () => {
    await checkLatestRelease(env, 1, fetchOf(() => release()) as typeof fetch);
    const u = await login(`rel-set-${tag}@x.com`, "owner");
    const body = (await (
      await api(app, R.settings, u.cookie)
    ).json()) as object;
    expect(Object.keys(body).sort()).toEqual(["defaultVisibility", "name"]);
  });
});
