import { LIMITS } from "@oa/shared";
import { signContent } from "../content/signing.js";
import type { Env } from "../env.js";
import { contentOrigin } from "../http/errors.js";
import { decodeBase64 } from "../util/base64.js";

// Server-side thumbnails (spec §6.9 stretch) through Browser Run, run from the
// artifact DO's alarm (runtime/do.ts), never on a request, and strictly
// best-effort: the client upload (PUT /thumbnail) stays the fallback. Without a
// BROWSER binding, past the day's stop, or when a capture fails, nothing here
// writes anything. Both paths store through writeThumbnail, which keeps the
// stored thumbnail at the newest version written.

export const THUMB = {
  width: 1280,
  height: 800,
  /** webp quality steps, highest first, until it fits LIMITS.thumbnailBytes. */
  qualities: [80, 60, 40, 25] as const,
  /** Whole capture, launch to last screenshot. */
  totalMs: 15_000,
  navigationMs: 8_000,
  /** The signed content URL's lifetime: enough for one capture. */
  urlTtlSec: 60,
  /** Free plan: 1 new browser per 20 s per account; one launch per gap here. */
  launchGapMs: 20_000,
} as const;

/**
 * What the job did. "deferred": the launch slot was taken (no browser used);
 * "launch_failed": the browser did not start for a reason other than the
 * daily quota (the DO backs off THUMB_LAUNCH_BACKOFF_MS).
 */
export type ThumbResult =
  | "stored"
  | "skipped"
  | "stopped"
  | "deferred"
  | "launch_failed"
  | "failed";

// The slice of @cloudflare/puppeteer this uses (tests pass a fake).
type ThumbRequest = {
  url(): string;
  isNavigationRequest(): boolean;
  frame(): unknown;
  isInterceptResolutionHandled(): boolean;
  abort(reason?: string): Promise<void>;
  continue(): Promise<void>;
};
type ThumbPage = {
  setViewport(v: { width: number; height: number }): Promise<void>;
  setRequestInterception(on: boolean): Promise<void>;
  on(event: string, handler: (x: never) => void): unknown;
  mainFrame(): unknown;
  url(): string;
  goto(
    url: string,
    o: { waitUntil: "load"; timeout: number },
  ): Promise<unknown>;
  waitForFunction(fn: string, o: { timeout: number }): Promise<unknown>;
  waitForNetworkIdle(o: {
    concurrency: number;
    idleTime: number;
    timeout: number;
  }): Promise<void>;
  screenshot(o: {
    type: "webp";
    quality: number;
    encoding: "base64";
  }): Promise<string>;
};
type ThumbBrowser = { newPage(): Promise<ThumbPage>; close(): Promise<void> };
export type ThumbLaunch = (binding: Fetcher) => Promise<ThumbBrowser>;

/** Lazy: puppeteer (~350 KB) is only evaluated in an alarm that captures. */
const puppeteerLaunch: ThumbLaunch = async (binding) => {
  const { default: puppeteer } = await import("@cloudflare/puppeteer");
  return (await puppeteer.launch(binding)) as unknown as ThumbBrowser;
};

const STOP_KEY = "browser_stop";
const SLOT_KEY = "browser_slot";
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const thumbKey = (id: string) => `thumbs/${id}.webp`;

class LaunchError extends Error {}
class TimeoutError extends Error {}

/** Browser Run's 429 (status or text) or its daily "time limit exceeded": stop for the UTC day. */
const isBudgetError = (e: unknown) =>
  (e as { status?: unknown })?.status === 429 ||
  /\b429\b|time limit exceeded/i.test(String((e as Error)?.message ?? e));

/**
 * Per format, the page's own "rendered" signal: renderer pages set
 * <html data-oa-rendered> (packages/render boot), a pdf also needs its first
 * page's canvas; html is ready once loaded with the runtime installed (top
 * level is the runtime's raw view, which sends no hello).
 */
const READY: Record<string, string> = {
  html: 'document.readyState === "complete" && "openArtifacts" in window',
  markdown: 'document.documentElement.hasAttribute("data-oa-rendered")',
  code: 'document.documentElement.hasAttribute("data-oa-rendered")',
  pdf: 'document.documentElement.hasAttribute("data-oa-rendered") && !!document.querySelector(".page canvas, .oa-error")',
};

const sameOrigin = (u: string, origin: string) => {
  try {
    return new URL(u).origin === origin;
  } catch {
    return false;
  }
};

/**
 * Stores `bytes` as thumbs/{id}.webp for `version` unless a newer version's
 * thumbnail is stored (→ "stale"; an equal version is replaced). The R2 put is
 * conditional on the object just read, so of two racing writers the older
 * version can never land last; D1 thumbnail_version only moves forward.
 */
export async function writeThumbnail(
  env: Env,
  id: string,
  version: number,
  bytes: Uint8Array,
  by: "server" | "client",
): Promise<"stored" | "stale"> {
  for (let i = 0; i < 3; i++) {
    const prev = await env.FILES.head(thumbKey(id));
    if (prev && Number(prev.customMetadata?.v ?? 0) > version) return "stale";
    const put = await env.FILES.put(thumbKey(id), bytes, {
      onlyIf: prev
        ? { etagMatches: prev.etag }
        : new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType: "image/webp" },
      customMetadata: { v: String(version), by },
    });
    if (!put) continue;
    await env.DB.prepare(
      `update artifacts set has_thumbnail = 1, thumbnail_version = ?2
       where id = ?1 and deleted_at is null and coalesce(thumbnail_version, 0) <= ?2`,
    )
      .bind(id, version)
      .run();
    return "stored";
  }
  // Lost three races in a row: newer writers are active; let them win.
  return "stale";
}

/**
 * One capture of `version` (the artifact's current one). Order: binding,
 * artifact state (current version, no thumbnail of it yet), the day's stop
 * (D1 counters), then the account-wide launch slot, so skips cost no browser
 * time. Stored through writeThumbnail: a newer client upload meanwhile wins.
 */
export async function captureThumbnail(
  env: Env,
  id: string,
  version: number,
  o: { launch?: ThumbLaunch; now?: number; totalMs?: number } = {},
): Promise<ThumbResult> {
  const binding = env.BROWSER;
  if (!binding) return "skipped";
  const now = o.now ?? Date.now();
  const row = await env.DB.prepare(
    "select current_version v, thumbnail_version t, format f from artifacts where id = ? and deleted_at is null",
  )
    .bind(id)
    .first<{ v: number; t: number | null; f: string }>();
  if (row?.v !== version || (row.t ?? 0) >= version) return "skipped";
  const day = utcDay(now);
  const stop = await env.DB.prepare(
    "select 1 x from counters where key = ? and day = ?",
  )
    .bind(STOP_KEY, day)
    .first();
  if (stop) return "stopped";
  const slot = await env.DB.prepare(
    `insert into counters (key, n, day) values (?1, ?2, ?3)
     on conflict (key) do update set n = excluded.n, day = excluded.day
     where counters.n <= ?2 - ?4 returning n`,
  )
    .bind(SLOT_KEY, now, day, THUMB.launchGapMs)
    .first();
  if (!slot) return "deferred";

  let bytes: Uint8Array | null;
  try {
    const { prefix } = await signContent(
      env,
      id,
      version,
      now,
      THUMB.urlTtlSec,
    );
    bytes = await shoot(
      binding,
      `${contentOrigin(env)}${prefix}__view`,
      o.launch ?? puppeteerLaunch,
      o.totalMs ?? THUMB.totalMs,
      READY[row.f] ?? null,
    );
  } catch (e) {
    const stopped = isBudgetError(e);
    if (stopped)
      await env.DB.prepare(
        `insert into counters (key, n, day) values (?1, 1, ?2)
         on conflict (key) do update set n = 1, day = excluded.day`,
      )
        .bind(STOP_KEY, day)
        .run();
    const result: ThumbResult = stopped
      ? "stopped"
      : e instanceof LaunchError
        ? "launch_failed"
        : "failed";
    console.error(
      JSON.stringify({
        evt: `thumbnail_${result}`,
        artifactId: id,
        version,
        error: String((e as Error)?.message ?? e).slice(0, 300),
      }),
    );
    return result;
  }
  if (!bytes) return "failed";
  return (await writeThumbnail(env, id, version, bytes, "server")) === "stored"
    ? "stored"
    : "skipped";
}

/**
 * Launches one browser, loads `url` with every top-level navigation (and
 * redirect) pinned to its origin, and screenshots the 1280×800 viewport as
 * webp, lowering the quality until it fits. Subresources are left to the
 * content host's CSP. The browser is fresh (no cookies or storage) and always
 * closed, at `totalMs` at the latest. null: too large at every quality.
 */
async function shoot(
  binding: Fetcher,
  url: string,
  launch: ThumbLaunch,
  totalMs: number,
  ready: string | null,
): Promise<Uint8Array | null> {
  const origin = new URL(url).origin;
  let browser: ThumbBrowser | null = null;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError("thumbnail capture timed out")),
      totalMs,
    );
  });
  const run = async (): Promise<Uint8Array | null> => {
    let b: ThumbBrowser;
    try {
      b = await launch(binding);
    } catch (e) {
      throw new LaunchError(String((e as Error)?.message ?? e));
    }
    // Launched after the deadline: close it here, nobody else will.
    if (done) {
      await b.close().catch(() => {});
      throw new TimeoutError("thumbnail capture timed out");
    }
    browser = b;
    const page = await b.newPage();
    await page.setViewport({ width: THUMB.width, height: THUMB.height });
    await page.setRequestInterception(true);
    let left = false;
    page.on("request", (req: ThumbRequest) => {
      if (req.isInterceptResolutionHandled()) return;
      const top = req.isNavigationRequest() && req.frame() === page.mainFrame();
      if (top && !sameOrigin(req.url(), origin)) {
        left = true;
        void req.abort("blockedbyclient").catch(() => {});
      } else void req.continue().catch(() => {});
    });
    page.on("popup", (p: { close(): Promise<void> }) => {
      void p.close().catch(() => {});
    });
    page.on("dialog", (d: { dismiss(): Promise<void> }) => {
      void d.dismiss().catch(() => {});
    });
    const t0 = Date.now();
    try {
      await page.goto(url, { waitUntil: "load", timeout: THUMB.navigationMs });
    } catch (e) {
      // A slow page is shot as it is; anything else (or leaving) fails.
      if (left || (e as Error)?.name !== "TimeoutError") throw e;
    }
    if (left || !sameOrigin(page.url(), origin))
      throw new Error("navigation left the content host");
    // The page's readiness signal, within the same 8 s; else a short
    // networkidle2-style settle (≤ 2 inflight requests for 500 ms).
    const left8s = Math.max(0, THUMB.navigationMs - (Date.now() - t0));
    const signalled =
      ready !== null &&
      (await page.waitForFunction(ready, { timeout: left8s }).then(
        () => true,
        () => false,
      ));
    if (!signalled)
      await page
        .waitForNetworkIdle({ concurrency: 2, idleTime: 500, timeout: 2_000 })
        .catch(() => {});
    if (left || !sameOrigin(page.url(), origin))
      throw new Error("navigation left the content host");
    for (const quality of THUMB.qualities) {
      // base64 straight from CDP, decoded natively (decodeBase64).
      const b64 = await page.screenshot({
        type: "webp",
        quality,
        encoding: "base64",
      });
      const shot = decodeBase64(b64);
      if (!shot) throw new Error("screenshot is not base64");
      if (shot.byteLength <= LIMITS.thumbnailBytes) return shot;
    }
    return null;
  };
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    done = true;
    clearTimeout(timer);
    await (browser as ThumbBrowser | null)?.close().catch(() => {});
  }
}
