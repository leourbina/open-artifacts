// Daily latest-release check (B3). The cron asks GitHub once a day for the
// latest stable release and stores it in one D1 `settings` row. D1, not KV:
// /me already reads every settings row in one statement, so the badge costs
// no extra read, and one D1 write a day stays clear of the Free plan's KV
// write cap (1,000/day) that OAuth already spends. Failures keep the last
// good value and record checkError; nothing here throws.
import type { InstanceUpdate, Role } from "@oa/shared";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { VERSION } from "../version.gen.js";

export const RELEASE_REPO = "open-artifacts-ai/open-artifacts";
export const RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
export const RELEASE_KEY = "latest_release";
const TIMEOUT_MS = 5000;
/** A release JSON is a few KB; anything far larger is not one. */
const MAX_BODY = 1 << 20;

/** The settings row. The release fields are the last good check; checkError
 * and errorAt describe the latest failure (null after a success). */
export type StoredRelease = {
  tag?: string;
  version?: string;
  publishedAt?: string | null;
  url?: string;
  breaking?: boolean;
  /** ms epoch of the last good check. */
  checkedAt?: number;
  checkError: string | null;
  errorAt: number | null;
};

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** [major, minor, patch] for a plain X.Y.Z (a leading v allowed), else null. */
export function parseSemver(v: string): [number, number, number] | null {
  const m = SEMVER.exec(v.startsWith("v") ? v.slice(1) : v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** a < b, both plain X.Y.Z. */
function lessThan(
  a: [number, number, number],
  b: [number, number, number],
): boolean {
  for (let i = 0; i < 3; i++)
    if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number);
  return false;
}

const SET =
  "insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value";
const GET = "select value from settings where key = ?";

export function parseStored(
  raw: string | undefined | null,
): StoredRelease | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as StoredRelease;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

type Outcome =
  | {
      ok: true;
      tag: string;
      version: string;
      publishedAt: string | null;
      breaking: boolean;
    }
  | { ok: false; error: string };

async function fetchLatest(fetcher: typeof fetch): Promise<Outcome> {
  let r: Response;
  try {
    r = await fetcher(RELEASE_API, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": `open-artifacts/${VERSION}`,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network",
    };
  }
  if (!r.ok) {
    await r.body?.cancel();
    // 403/429: the unauthenticated limit (60/h per egress IP). 404: no
    // stable release yet. Neither is "up to date".
    return {
      ok: false,
      error:
        r.status === 403 || r.status === 429
          ? "rate_limited"
          : r.status === 404
            ? "no_release"
            : `http_${r.status}`,
    };
  }
  let body: {
    tag_name?: unknown;
    body?: unknown;
    published_at?: unknown;
    draft?: unknown;
    prerelease?: unknown;
  };
  try {
    const text = await r.text();
    if (text.length > MAX_BODY) return { ok: false, error: "bad_json" };
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: "bad_json" };
  }
  if (!body || typeof body !== "object")
    return { ok: false, error: "bad_json" };
  // releases/latest already skips drafts and prereleases; guard anyway.
  if (body.draft === true || body.prerelease === true)
    return { ok: false, error: "no_release" };
  const tag = typeof body.tag_name === "string" ? body.tag_name : "";
  if (!tag) return { ok: false, error: "no_release" };
  if (!parseSemver(tag)) return { ok: false, error: "bad_tag" };
  return {
    ok: true,
    tag,
    version: tag.startsWith("v") ? tag.slice(1) : tag,
    publishedAt:
      typeof body.published_at === "string" ? body.published_at : null,
    breaking:
      typeof body.body === "string" && body.body.includes("BREAKING CHANGE"),
  };
}

/** Cron: fetch the latest release and store it. Never throws. */
export async function checkLatestRelease(
  env: Env,
  now: number,
  fetcher: typeof fetch = fetch,
): Promise<StoredRelease | null> {
  try {
    const out = await fetchLatest(fetcher);
    let next: StoredRelease;
    if (out.ok) {
      next = {
        tag: out.tag,
        version: out.version,
        publishedAt: out.publishedAt,
        // Built from the validated tag, not the response's html_url.
        url: `https://github.com/${RELEASE_REPO}/releases/tag/${encodeURIComponent(out.tag)}`,
        breaking: out.breaking,
        checkedAt: now,
        checkError: null,
        errorAt: null,
      };
    } else {
      const prev = parseStored(
        (await stmt(env.DB, GET).bind(RELEASE_KEY).first<{ value: string }>())
          ?.value,
      );
      next = { ...(prev ?? {}), checkError: out.error, errorAt: now };
      console.warn("release check", out.error);
    }
    await stmt(env.DB, SET).bind(RELEASE_KEY, JSON.stringify(next)).run();
    return next;
  } catch (e) {
    console.error("release check", e);
    return null;
  }
}

/** Me.instance.update: owner and admins only, and only after a good check. */
export function instanceUpdate(
  role: Role,
  raw: string | undefined,
  current: string = VERSION,
): InstanceUpdate | null {
  if (role !== "owner" && role !== "admin") return null;
  const s = parseStored(raw);
  if (!s || typeof s.version !== "string" || typeof s.checkedAt !== "number")
    return null;
  const latest = parseSemver(s.version);
  if (!latest) return null;
  const cur = parseSemver(current);
  return {
    latestVersion: s.version,
    current,
    // A -dev/prerelease or otherwise non-plain build is custom: no badge.
    custom: !cur,
    updateAvailable: !!cur && lessThan(cur, latest),
    breaking: s.breaking === true,
    url:
      typeof s.url === "string"
        ? s.url
        : `https://github.com/${RELEASE_REPO}/releases`,
    checkedAt: new Date(s.checkedAt).toISOString(),
  };
}
