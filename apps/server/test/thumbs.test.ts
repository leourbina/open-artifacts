import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ArtifactSummary,
  LIMITS,
  type Member,
  newId,
  R,
} from "@oa/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { contentOrigin } from "../src/http/errors.js";
import {
  type ArtifactRuntime,
  runtimeStub,
  THUMB_LAUNCH_BACKOFF_MS,
  THUMB_MAX_ATTEMPTS,
  THUMB_RETRY_MS,
} from "../src/runtime/do.js";
import {
  publish,
  putThumbnail,
  restoreVersion,
} from "../src/services/artifacts.js";
import {
  captureThumbnail,
  THUMB,
  type ThumbResult,
} from "../src/services/thumbs.js";
import { getUser } from "../src/services/users.js";
import { decodeBase64 } from "../src/util/base64.js";
import { api, fetchAndWait, login } from "./helpers.js";

// Server-side thumbnails (spec §6.9 stretch): Browser Run, driven from the
// artifact DO's alarm. BROWSER is faked: these tests pin what the job asks of
// the browser (origin, viewport, format, size) and how it treats failures.
const tag = newId().slice(0, 6).toLowerCase();
let owner: Member;
let cookie: string;
const app = createApp();
/** env with a BROWSER binding (a placeholder; captures pass their fake's). */
const withBrowser = {
  ...(env as Env),
  BROWSER: {} as Fetcher,
  SERVER_THUMBNAILS: "on",
} as Env;
const key = (id: string) => `thumbs/${id}.webp`;

const webp = (n: number) => {
  const b = new Uint8Array(n);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WEBP"), 8);
  return b;
};

const b64 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 8192)
    s += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(s);
};

type Req = { url: string; nav: boolean; main: boolean };
type Fake = {
  /** The BROWSER binding: Browser Run's acquire + DevTools websocket. */
  binding: Fetcher;
  launched: number;
  closed: number;
  goto: string[];
  viewport: unknown;
  /** Fetch.enable patterns: which requests the capture intercepts. */
  patterns: unknown;
  shots: { format: string; quality: number; clip: { scale: number } }[];
  aborted: string[];
  continued: string[];
  /** Readiness polls (Runtime.evaluate), then how often the settle fallback ran. */
  waited: string[];
  idled: number;
  /** Every CDP method the capture sent, in order. */
  methods: string[];
};

/**
 * A Browser Run binding speaking enough CDP for a capture. Page.navigate
 * replays `requests` (the first is the navigation itself) as Fetch.requestPaused
 * for documents (all the capture intercepts), waiting for each answer.
 */
function fake(
  o: {
    requests?: (url: string) => Req[];
    sizes?: number[];
    /** The acquire answers with this status, or the binding throws it. */
    launchError?: Error | { status: number; text: string };
    /** Page.navigate answers with this CDP error. */
    gotoError?: Error;
    /** The load event never comes (navigation runs past its budget). */
    noLoad?: boolean;
    /** Page.navigate never answers. */
    hang?: boolean;
    onShot?: () => Promise<void>;
    /** false: the readiness signal never comes. */
    ready?: boolean;
  } = {},
): Fake {
  const sizes = [...(o.sizes ?? [10_000])];
  const listeners = new Map<string, ((e: { data: string }) => void)[]>();
  const emit = (m: unknown) =>
    setTimeout(() => {
      for (const h of listeners.get("message") ?? [])
        h({ data: JSON.stringify(m) });
    }, 0);
  const waiting = new Map<string, (failed: boolean) => void>();
  const TARGET = "T1";
  const SESSION = "S1";
  let req = 0;
  const pause = (r: Req) =>
    new Promise<boolean>((resolve) => {
      const requestId = `r${++req}`;
      waiting.set(requestId, resolve);
      emit({
        method: "Fetch.requestPaused",
        sessionId: SESSION,
        params: {
          requestId,
          request: { url: r.url },
          frameId: r.main ? TARGET : "F2",
          resourceType: r.nav ? "Document" : "Script",
        },
      });
    });
  const reply = (id: number, result: unknown) => emit({ id, result });
  const onCommand = async (m: {
    id: number;
    method: string;
    params: Record<string, unknown>;
  }) => {
    f.methods.push(m.method);
    const p = m.params;
    switch (m.method) {
      case "Target.createTarget":
        return reply(m.id, { targetId: TARGET });
      case "Target.attachToTarget":
        return reply(m.id, { sessionId: SESSION });
      case "Emulation.setDeviceMetricsOverride":
        f.viewport = { width: p.width, height: p.height };
        return reply(m.id, {});
      case "Fetch.enable":
        f.patterns = p.patterns;
        return reply(m.id, {});
      case "Fetch.continueRequest":
      case "Fetch.failRequest": {
        const failed = m.method === "Fetch.failRequest";
        waiting.get(String(p.requestId))?.(failed);
        return reply(m.id, {});
      }
      case "Page.navigate": {
        const u = String(p.url);
        f.goto.push(u);
        if (o.hang) return;
        if (o.gotoError)
          return emit({ id: m.id, error: { message: o.gotoError.message } });
        const reqs = (
          o.requests ?? ((x) => [{ url: x, nav: true, main: true }])
        )(u);
        const docs = reqs.filter((r) => r.nav);
        let first = true;
        for (const r of docs) {
          const failed = await pause(r);
          (failed ? f.aborted : f.continued).push(r.url);
          if (first && failed)
            return reply(m.id, { errorText: "net::ERR_BLOCKED_BY_CLIENT" });
          if (first) reply(m.id, { frameId: TARGET });
          first = false;
        }
        if (!o.noLoad)
          emit({
            method: "Page.loadEventFired",
            sessionId: SESSION,
            params: {},
          });
        return;
      }
      case "Runtime.evaluate": {
        const e = String(p.expression);
        if (e.includes("getEntriesByType")) {
          f.idled++;
          return reply(m.id, { result: { value: true } });
        }
        f.waited.push(e);
        return reply(m.id, { result: { value: o.ready !== false } });
      }
      case "Page.captureScreenshot": {
        f.shots.push(p as never);
        await o.onShot?.();
        return reply(m.id, { data: b64(webp(sizes.shift() ?? 10_000)) });
      }
      case "Browser.close":
        f.closed++;
        return reply(m.id, {});
      default:
        return reply(m.id, {});
    }
  };
  const socket = {
    accept() {},
    addEventListener(t: string, h: (e: { data: string }) => void) {
      listeners.set(t, [...(listeners.get(t) ?? []), h]);
    },
    send(msg: string) {
      void onCommand(JSON.parse(msg));
    },
    close() {},
  };
  const f: Fake = {
    launched: 0,
    closed: 0,
    goto: [],
    viewport: null,
    patterns: null,
    shots: [],
    aborted: [],
    continued: [],
    waited: [],
    idled: 0,
    methods: [],
    binding: {
      fetch: async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          expect(url).toBe("https://fake.host/v1/devtools/browser");
          const err = o.launchError;
          if (err instanceof Error) throw err;
          if (err) return new Response(err.text, { status: err.status });
          f.launched++;
          return Response.json({ sessionId: "sess-1" });
        }
        expect(url).toBe("https://fake.host/v1/devtools/browser/sess-1");
        expect(new Headers(init?.headers).get("upgrade")).toBe("websocket");
        return { status: 101, webSocket: socket } as unknown as Response;
      },
    } as unknown as Fetcher,
  };
  return f;
}

const pub = async (format = "html", content = "<p>x</p>") =>
  (
    await publish(
      env as Env,
      owner,
      { title: `t ${tag}`, format, content } as never,
      null,
    )
  ).id;
const hasThumb = async (id: string) =>
  (
    await env.DB.prepare("select has_thumbnail h from artifacts where id = ?")
      .bind(id)
      .first<{ h: number }>()
  )?.h;
const putRaw = (path: string, body: Uint8Array) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${path}`, {
      method: "PUT",
      headers: { cookie, "x-oa-request": "1", "content-type": "image/webp" },
      body: body as Uint8Array<ArrayBuffer>,
    }),
  );
const thumbVersion = async (id: string) =>
  (
    await env.DB.prepare(
      "select thumbnail_version t from artifacts where id = ?",
    )
      .bind(id)
      .first<{ t: number | null }>()
  )?.t;
const republish = async (id: string) =>
  (
    await publish(
      env as Env,
      owner,
      { id, title: `t ${tag}`, format: "html", content: "<p>2</p>" } as never,
      null,
      undefined,
      "version",
    )
  ).version;
const inDo = <T>(
  id: string,
  cb: (i: ArtifactRuntime) => T | Promise<T>,
  e: Env = env as Env,
) =>
  runInDurableObject(
    runtimeStub(e, id) as unknown as DurableObjectStub<ArtifactRuntime>,
    (i) => {
      (i as unknown as { env: Env }).env = e;
      return cb(i);
    },
  );
let clock = Date.parse("2026-10-19T12:00:00Z");
/** Each capture gets its own launch slot unless a test says otherwise. */
const next = () => {
  clock += THUMB.launchGapMs;
  return clock;
};
const on = (f: Fake) =>
  ({ ...(env as Env), BROWSER: f.binding, SERVER_THUMBNAILS: "on" }) as Env;
const capture = (id: string, v: number, f: Fake, e: Env = on(f)) =>
  captureThumbnail(e, id, v, { now: next() });

beforeAll(async () => {
  const l = await login(`thumbs-${tag}@x.com`);
  cookie = l.cookie;
  const m = await getUser(env as Env, l.userId);
  if (!m) throw new Error("no user");
  owner = m;
});
beforeEach(async () => {
  await env.DB.prepare(
    "delete from counters where key in ('browser_stop', 'browser_slot')",
  ).run();
});

describe("captureThumbnail", () => {
  it("without a BROWSER binding: skipped, no browser", async () => {
    const id = await pub();
    const f = fake();
    expect(await capture(id, 1, f, env as Env)).toBe("skipped");
    expect(f.launched).toBe(0);
  });

  it('off unless SERVER_THUMBNAILS is "on": a bound BROWSER alone is never called', async () => {
    for (const v of [undefined, "off", "ON", ""]) {
      const id = await pub();
      const f = fake();
      const e = {
        ...(env as Env),
        BROWSER: f.binding,
        SERVER_THUMBNAILS: v,
      } as Env;
      expect(await capture(id, 1, f, e)).toBe("skipped");
      expect(f.launched).toBe(0);
      expect(f.methods).toEqual([]);
    }
  });

  it("screenshots the signed content URL at 1200×750 (the client's size) as webp and stores it", async () => {
    for (const format of ["html", "markdown", "code", "pdf"]) {
      const id = await pub(format, format === "pdf" ? "%PDF-1.4" : "x");
      const f = fake();
      expect(await capture(id, 1, f)).toBe("stored");
      expect(f.goto).toHaveLength(1);
      const u = new URL(f.goto[0] ?? "");
      expect(u.origin).toBe(contentOrigin(env as Env));
      expect(u.pathname).toMatch(
        new RegExp(`^/c/\\d+\\.[A-Za-z0-9_-]{43}/${id}/v1/__view$`),
      );
      expect(u.search).toBe("");
      // Short-lived: well under the viewer's LIMITS.signedUrlTtlSec.
      const exp = Number(/\/c\/(\d+)\./.exec(u.pathname)?.[1]);
      expect(exp * 1000 - clock).toBeLessThanOrEqual(THUMB.urlTtlSec * 1000);
      expect(f.viewport).toEqual({ width: 1200, height: 750 });
      expect(f.shots[0]).toMatchObject({
        format: "webp",
        clip: { width: 1200, height: 750, scale: 1 },
      });
      expect(f.shots[0]?.quality).toBeLessThanOrEqual(60);
      // No Network domain: its per-request events are most of puppeteer's CPU.
      expect(f.methods.some((m) => m.startsWith("Network."))).toBe(false);
      expect(f.closed).toBe(1);
      expect(await hasThumb(id)).toBe(1);
      const obj = await env.FILES.head(key(id));
      expect(obj?.customMetadata).toMatchObject({ v: "1", by: "server" });
      expect(await thumbVersion(id)).toBe(1);
    }
  });

  it("aborts a top-level navigation or redirect off the content host; subresources pass", async () => {
    const id = await pub();
    const f = fake({
      requests: (u) => [
        { url: u, nav: true, main: true },
        { url: "https://cdn.example/x.js", nav: false, main: true },
        { url: "https://frame.example/", nav: true, main: false },
        { url: "https://evil.example/", nav: true, main: true },
      ],
    });
    expect(await capture(id, 1, f)).toBe("failed");
    expect(f.aborted).toEqual(["https://evil.example/"]);
    // Only documents are intercepted: subresources follow the CSP untouched.
    expect(f.patterns).toEqual([{ urlPattern: "*", resourceType: "Document" }]);
    expect(f.continued).toContain("https://frame.example/");
    expect(f.continued).not.toContain("https://cdn.example/x.js");
    expect(f.shots).toHaveLength(0);
    expect(f.closed).toBe(1);
    expect(await hasThumb(id)).toBe(0);
    expect(await env.FILES.head(key(id))).toBeNull();
  });

  it("a hung page hits the hard timeout and the browser is closed", async () => {
    const id = await pub();
    const f = fake({ hang: true });
    const t0 = Date.now();
    expect(
      await captureThumbnail(on(f), id, 1, { now: next(), totalMs: 50 }),
    ).toBe("failed");
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(f.closed).toBe(1);
    expect(await hasThumb(id)).toBe(0);
  });

  it("waits for the page's readiness signal per format; idle settle only without one", async () => {
    const expected: Record<string, RegExp> = {
      html: /openArtifacts/,
      markdown: /data-oa-rendered/,
      code: /data-oa-rendered/,
      pdf: /data-oa-rendered.*\.page canvas/,
    };
    for (const [format, re] of Object.entries(expected)) {
      const id = await pub(format, format === "pdf" ? "%PDF-1.4" : "x");
      const f = fake();
      expect(await capture(id, 1, f)).toBe("stored");
      expect(f.waited).toHaveLength(1);
      expect(f.waited[0]).toMatch(re);
      expect(f.idled).toBe(0);
    }
    const id = await pub();
    const slow = fake({ ready: false });
    expect(await capture(id, 1, slow)).toBe("stored");
    expect(slow.idled).toBe(1);
  });

  it("stops the day on each quota signal: 429 status, 429 text, time limit exceeded", async () => {
    for (const err of [
      { status: 429, text: "Too Many Requests" },
      new Error("code: 429: Too Many Requests"),
      new Error("Browser time limit exceeded for today"),
    ]) {
      await env.DB.prepare(
        "delete from counters where key = 'browser_stop'",
      ).run();
      const id = await pub();
      expect(await capture(id, 1, fake({ launchError: err }))).toBe("stopped");
      const g = fake();
      expect(await capture(id, 1, g)).toBe("stopped");
      expect(g.launched).toBe(0);
    }
  });

  it("a goto that uses up the navigation budget is shot as it is (no 0 ms = endless wait)", async () => {
    const id = await pub("markdown", "x");
    const f = fake({ noLoad: true });
    expect(
      await captureThumbnail(on(f), id, 1, {
        now: next(),
        navigationMs: 20,
        totalMs: 3_000,
      }),
    ).toBe("stored");
    expect(f.waited).toEqual([]);
    expect(f.idled).toBe(0);
    expect(f.shots.length).toBeGreaterThan(0);
    expect(f.closed).toBe(1);
  });

  it("a launch error that is not the quota does not stop the day", async () => {
    const id = await pub();
    const f = fake({ launchError: new Error("WebSocket connection failed") });
    expect(await capture(id, 1, f)).toBe("launch_failed");
    expect(
      await env.DB.prepare(
        "select 1 x from counters where key = 'browser_stop'",
      ).first(),
    ).toBeNull();
    const g = fake();
    expect(await capture(id, 1, g)).toBe("stored");
    expect(g.launched).toBe(1);
  });

  it("a launch error or quota 429 stops captures for the UTC day", async () => {
    const id = await pub();
    const f = fake({
      launchError: new Error(
        "Unable to create new browser: code: 429: message: Browser time limit exceeded for today",
      ),
    });
    expect(await capture(id, 1, f)).toBe("stopped");
    const g = fake();
    expect(await capture(id, 1, g)).toBe("stopped");
    expect(g.launched).toBe(0);
    // The next UTC day starts afresh.
    clock += 86_400_000;
    expect(await capture(id, 1, g)).toBe("stored");
  });

  it("a quota error mid-session also stops the day; a page error does not", async () => {
    const id = await pub();
    const bad = fake({ gotoError: new Error("net::ERR_NAME_NOT_RESOLVED") });
    expect(await capture(id, 1, bad)).toBe("failed");
    const quota = fake({
      gotoError: new Error("code: 429: Browser time limit exceeded for today"),
    });
    expect(await capture(id, 1, quota)).toBe("stopped");
    expect(quota.closed).toBe(1);
    expect(await capture(id, 1, fake())).toBe("stopped");
  });

  it("lowers the quality until the webp fits LIMITS.thumbnailBytes", async () => {
    const id = await pub();
    const big = LIMITS.thumbnailBytes + 1;
    const f = fake({ sizes: [big, big, LIMITS.thumbnailBytes] });
    expect(await capture(id, 1, f)).toBe("stored");
    const q = f.shots.map((s) => s.quality);
    expect(q).toHaveLength(3);
    expect(q[0]).toBeGreaterThan(q[1] ?? 0);
    expect(q[1]).toBeGreaterThan(q[2] ?? 0);
    expect((await env.FILES.head(key(id)))?.size).toBe(LIMITS.thumbnailBytes);

    const id2 = await pub();
    const never = fake({ sizes: Array(10).fill(big) });
    expect(await capture(id2, 1, never)).toBe("failed");
    expect(never.shots.length).toBe(THUMB.qualities.length);
    expect(await env.FILES.head(key(id2))).toBeNull();
  });

  it("skips a version that already has a thumbnail, and a stale or deleted version", async () => {
    const id = await pub();
    expect(await capture(id, 1, fake())).toBe("stored");
    const f = fake();
    expect(await capture(id, 1, f)).toBe("skipped");
    expect(await capture(id, 2, f)).toBe("skipped"); // not the current version
    expect(f.launched).toBe(0);
  });

  it("regenerates on every new version: v1's thumbnail is replaced by v2's", async () => {
    const id = await pub();
    await putThumbnail(env as Env, owner, id, webp(64)); // client, v1
    expect(await thumbVersion(id)).toBe(1);
    const v2 = await republish(id);
    expect(await capture(id, v2, fake({ sizes: [5_000] }))).toBe("stored");
    expect(await thumbVersion(id)).toBe(2);
    expect((await env.FILES.head(key(id)))?.customMetadata).toMatchObject({
      v: "2",
      by: "server",
    });
  });

  it("thumbnailUrl carries ?v=<thumbnailVersion> as a cache buster", async () => {
    const id = await pub();
    const get = async () =>
      (await (
        await api(app, R.artifact(id), cookie)
      ).json()) as ArtifactSummary;
    expect(await get()).toMatchObject({
      thumbnailUrl: null,
      thumbnailVersion: null,
    });
    await capture(id, 1, fake());
    const s1 = await get();
    expect(s1.thumbnailVersion).toBe(1);
    expect(s1.thumbnailUrl).toBe(`http://app.localhost${R.thumbnail(id)}?v=1`);
    const v2 = await republish(id);
    await capture(id, v2, fake());
    expect((await get()).thumbnailUrl).toBe(
      `http://app.localhost${R.thumbnail(id)}?v=2`,
    );
    // The image route itself ignores the buster.
    const img = await api(app, `${R.thumbnail(id)}?v=2`, cookie);
    expect(img.status).toBe(200);
  });

  it("client vs server ordering: the newer version always ends up stored", async () => {
    // A client still showing v1 uploads while the server captures v2.
    const id = await pub();
    const v2 = await republish(id);
    const g = fake({
      sizes: [5_000],
      onShot: () => putThumbnail(env as Env, owner, id, webp(64), 1),
    });
    expect(await capture(id, v2, g)).toBe("stored");
    expect(await thumbVersion(id)).toBe(2);
    expect((await env.FILES.head(key(id)))?.size).toBe(5_000);
    // A late v1 upload is refused with 409 and changes nothing.
    await expect(
      putThumbnail(env as Env, owner, id, webp(64), 1),
    ).rejects.toMatchObject({ code: "conflict" });
    const r = await putRaw(`${R.thumbnail(id)}?v=1`, webp(64));
    expect(r.status).toBe(409);
    expect(await thumbVersion(id)).toBe(2);

    // The server capturing v1 while a client uploads v2 (published meanwhile).
    const id2 = await pub();
    const h = fake({
      onShot: async () => {
        const v = await republish(id2);
        await putThumbnail(env as Env, owner, id2, webp(88), v);
      },
    });
    expect(await capture(id2, 1, h)).toBe("skipped");
    expect(await thumbVersion(id2)).toBe(2);
    expect((await env.FILES.head(key(id2)))?.size).toBe(88);
  });

  it("client ?v= must be a version that exists", async () => {
    const id = await pub();
    for (const v of ["0", "x", "2"]) {
      const r = await putRaw(`${R.thumbnail(id)}?v=${v}`, webp(64));
      expect(r.status).toBe(400);
    }
  });

  it("one browser launch per THUMB.launchGapMs across all artifacts", async () => {
    const a = await pub();
    const b = await pub();
    const t = next();
    const f = fake();
    expect(await captureThumbnail(on(f), a, 1, { now: t })).toBe("stored");
    expect(await captureThumbnail(on(f), b, 1, { now: t + 1_000 })).toBe(
      "deferred",
    );
    expect(f.launched).toBe(1);
  });
});

describe("decodeBase64", () => {
  it("decodes with Uint8Array.fromBase64 or, without it, atob", () => {
    const bytes = webp(70_000).map((_, i) => (i * 7) % 251);
    const enc = b64(bytes);
    expect(decodeBase64(enc)).toEqual(bytes);
    expect(decodeBase64(enc, null)).toEqual(bytes);
    expect(decodeBase64("not base64!", null)).toBeNull();
  });
});

describe("thumbnail job on the artifact DO", () => {
  it("publish and restore queue one debounced job (latest version) only with BROWSER", async () => {
    const id = await pub();
    expect(await inDo(id, (i) => i.pendingThumbnail())).toBeNull();

    await inDo(id, (i) => i.scheduleIndex(id, 2, true), withBrowser);
    await inDo(id, (i) => i.scheduleIndex(id, 3, true), withBrowser);
    await inDo(id, (i) => i.scheduleIndex(id, 2, true), withBrowser);
    expect(
      await inDo(id, (i) => i.pendingThumbnail(), withBrowser),
    ).toMatchObject({ artifactId: id, version: 3, attempts: 0 });
    // Index-only enqueues (undelete, reindexStale) never add one.
    const other = await pub();
    await inDo(other, (i) => i.scheduleIndex(other, 1), withBrowser);
    expect(await inDo(other, (i) => i.pendingThumbnail())).toBeNull();
  });

  it("with BROWSER bound but SERVER_THUMBNAILS unset, publish and restore schedule nothing", async () => {
    const id = await pub();
    const f = fake();
    const gated = { ...(env as Env), BROWSER: f.binding } as Env;
    await inDo(id, () => {}, gated);
    await publish(
      gated,
      owner,
      { id, title: `t ${tag}`, format: "html", content: "<p>2</p>" } as never,
      null,
      undefined,
      "version",
    );
    await restoreVersion(gated, owner, id, 1, null);
    expect(await inDo(id, (i) => i.pendingThumbnail(), gated)).toBeNull();
    expect(await inDo(id, (i) => i.thumbnailJob(), gated)).toBeNull();
    // The index job is still queued; running the alarm calls no browser.
    await inDo(id, (i) => i.alarm(), gated);
    expect(f.launched).toBe(0);
  });

  it("restoreVersion enqueues a thumbnail job for the new version", async () => {
    const id = await pub();
    // The DO reads BROWSER from its own env: give this instance one.
    await inDo(id, () => {}, withBrowser);
    await restoreVersion(withBrowser, owner, id, 1, null);
    expect(
      await inDo(id, (i) => i.pendingThumbnail(), withBrowser),
    ).toMatchObject({ version: 2 });
  });

  it("never captures in the alarm run that indexed; re-arms at once for it", async () => {
    const id = await pub();
    const order: string[] = [];
    await inDo(
      id,
      async (i) => {
        await i.scheduleIndex(id, 1, true);
        i.indexer = async () => {
          order.push("index");
        };
        i.thumbnailer = async () => {
          order.push("thumb");
          return "stored";
        };
        const t = Date.now();
        await i.alarm();
        expect(order).toEqual(["index"]);
        const at = await (
          i as unknown as { ctx: DurableObjectState }
        ).ctx.storage.getAlarm();
        expect(at).not.toBeNull();
        expect(at ?? 0).toBeLessThanOrEqual(Date.now());
        expect(at ?? 0).toBeGreaterThanOrEqual(t - 1);
        await i.alarm();
        expect(order).toEqual(["index", "thumb"]);
        expect(i.thumbnailJob()).toMatchObject({ state: "done", attempts: 1 });
      },
      withBrowser,
    );
  });

  it("counts the attempt before launching; a killed run is retried once, then abandoned", async () => {
    const id = await pub();
    const seen: (number | undefined)[] = [];
    await inDo(
      id,
      async (i) => {
        await i.scheduleIndex(id, 1, true);
        i.indexer = async () => {};
        await i.alarm(); // indexes only
        // Drive the alarm by hand from here on (no real alarm interleaving).
        const storage = (i as unknown as { ctx: DurableObjectState }).ctx
          .storage;
        await storage.deleteAlarm();
        // A capture that never returns stands in for a CPU-limit kill.
        i.thumbnailer = async () => {
          seen.push(i.thumbnailJob()?.attempts);
          return new Promise<never>(() => {});
        };
        void i.alarm();
        await new Promise((r) => setTimeout(r, 20));
        expect(seen).toEqual([1]);
        expect(i.pendingThumbnail()).toMatchObject({ attempts: 1 });
        // Armed before launching, so the runtime comes back after a kill.
        const armed = await storage.getAlarm();
        expect(armed ?? 0).toBeGreaterThan(Date.now() + THUMB_RETRY_MS - 5_000);
        // Its retry alarm comes THUMB_RETRY_MS later.
        i.now = () => Date.now() + THUMB_RETRY_MS;
        void i.alarm();
        await new Promise((r) => setTimeout(r, 20));
        expect(seen).toEqual([1, 2]);
        i.now = () => Date.now() + 2 * THUMB_RETRY_MS;
        await i.alarm();
        expect(seen).toEqual([1, 2]);
        expect(i.thumbnailJob()).toMatchObject({
          state: "no_thumb",
          attempts: THUMB_MAX_ATTEMPTS,
        });
      },
      withBrowser,
    );
  });

  it("a failed capture is not retried; a deferral uses the one retry", async () => {
    const id = await pub();
    const results: ThumbResult[] = ["failed"];
    await inDo(
      id,
      async (i) => {
        await i.scheduleIndex(id, 1, true);
        i.indexer = async () => {};
        await i.alarm();
        let calls = 0;
        i.thumbnailer = async () => {
          calls++;
          return results.shift() ?? "stored";
        };
        await i.alarm();
        expect(calls).toBe(1);
        expect(i.thumbnailJob()).toMatchObject({ state: "no_thumb" });

        await i.scheduleIndex(id, 2, true);
        await i.alarm(); // indexes v2
        results.push("deferred", "deferred");
        await i.alarm();
        expect(i.pendingThumbnail()).toMatchObject({ version: 2, attempts: 1 });
        i.now = () => Date.now() + THUMB.launchGapMs;
        await i.alarm();
        expect(calls).toBe(3);
        expect(i.thumbnailJob()).toMatchObject({
          version: 2,
          state: "no_thumb",
          attempts: 2,
        });
      },
      withBrowser,
    );
  });

  it("a non-quota launch error backs off an hour, retries once, then gives up", async () => {
    const id = await pub();
    await inDo(
      id,
      async (i) => {
        await i.scheduleIndex(id, 1, true);
        i.indexer = async () => {};
        await i.alarm();
        let calls = 0;
        i.thumbnailer = async () => {
          calls++;
          return "launch_failed";
        };
        const t = Date.now();
        await i.alarm();
        const job = i.pendingThumbnail();
        expect(job).toMatchObject({ attempts: 1 });
        expect(job?.due ?? 0).toBeGreaterThanOrEqual(
          t + THUMB_LAUNCH_BACKOFF_MS,
        );
        await i.alarm(); // not due yet
        expect(calls).toBe(1);
        i.now = () => Date.now() + THUMB_LAUNCH_BACKOFF_MS + 1_000;
        await i.alarm();
        expect(calls).toBe(2);
        expect(i.thumbnailJob()).toMatchObject({
          state: "no_thumb",
          attempts: 2,
        });
      },
      withBrowser,
    );
  });
});
