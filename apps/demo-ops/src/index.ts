/**
 * Demo ops Worker: once a minute, read today's activity from the demo artifacts and write
 * aggregates into the dashboard artifact's own db (collection `stats`):
 *   stats/today          the headline numbers (see TodayStats)
 *   stats/hourly-<DAY>   writes per UTC hour
 * One doc per `PUT /api/v1/artifacts/:id/data/stats/<doc>`; never `PUT /data` (the atomic
 * reset). It serves nothing (fetch is always 404) and reads only the artifacts named by its
 * own vars. Unknown or missing docs count as 0.
 */
import { isId } from "@oa/shared";
import {
  chessState,
  countries,
  type Doc,
  type GameState,
  type Hourly,
  hourlyNext,
  pixelCount,
  ticTacToeState,
  utcDay,
} from "./metrics.js";

export interface Env {
  /** Secret: owner PAT for the demo instance. Never logged. */
  DEMO_OA_TOKEN: string;
  DEMO_BASE_URL: string;
  DASHBOARD_ARTIFACT_ID: string;
  /** Source artifact ids. An empty or invalid one skips that source (reported in `missing`). */
  POLL_ID: string;
  CANVAS_ID: string;
  MAP_ID: string;
  TICTACTOE_ID: string;
  CHESS_ID: string;
}

/** stats/today. Design's dashboard reads this shape. */
export interface TodayStats {
  day: string;
  updatedAt: number;
  votes: number;
  gamesInProgress: { tictactoe: number; chess: number };
  moves: { tictactoe: number; chess: number };
  pixels: number;
  countries: number;
  pins: number;
  /** Metrics whose value is a lower bound (a read cap or a size cap was hit). */
  truncated: string[];
  /** Sources skipped because their id var is empty or invalid. */
  missing: string[];
  /** Sources that errored or were not reached (value 0). */
  failed: string[];
}

const PAGE_LIMIT = 200;
const MAX_PAGES = 2;
const TIMEOUT_MS = 5000;
const MAX_BYTES = 512 * 1024;
/** A tick must end before the next minute's starts. */
const TICK_DEADLINE_MS = 40_000;
/** Subrequests per tick, writes included (Free plan allows 50). */
export const MAX_REQUESTS = 45;
const WRITES = 2;

class TooLarge extends Error {}

type Ctx = {
  env: Env;
  base: string;
  signal: AbortSignal;
  /** Reads left (the writes' share is already reserved). */
  budget: number;
  truncated: Set<string>;
};

/** The JSON body, or throws TooLarge past MAX_BYTES (declared or read). */
async function readJson(res: Response): Promise<unknown> {
  if (Number(res.headers.get("content-length")) > MAX_BYTES)
    throw new TooLarge("response too large");
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new TooLarge("response too large");
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(buf));
}

const headers = (env: Env) => ({
  authorization: `Bearer ${env.DEMO_OA_TOKEN}`,
  "content-type": "application/json",
});

/** A GET; null for 404. Throws on other failures, a spent budget or the deadline. */
async function request(
  t: Ctx,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown | null> {
  if (t.signal.aborted) throw new Error("tick deadline reached");
  if (t.budget <= 0) throw new Error("request budget spent");
  t.budget--;
  const res = await fetch(`${t.base}${path}`, {
    method,
    headers: headers(t.env),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([t.signal, AbortSignal.timeout(TIMEOUT_MS)]),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`status ${res.status}`);
  return readJson(res);
}

const get = (t: Ctx, path: string) => request(t, "GET", path);

const data = (id: string, col: string, doc = "") =>
  `/api/v1/artifacts/${id}/data/${col}${doc ? `/${doc}` : ""}`;

/** The data of one doc, or undefined when it does not exist. */
async function getDoc(t: Ctx, id: string, col: string, doc: string) {
  const d = (await get(t, data(id, col, doc))) as { data?: unknown } | null;
  return d?.data;
}

/** Up to `pages` pages of 200 docs; `capped` when more remain, `large` on an oversize page. */
async function listDocs(
  t: Ctx,
  id: string,
  col: string,
  pages = MAX_PAGES,
  /** With `where`, the pages come from `POST .../data/:col/query` (docs matching it). */
  where?: Record<string, string>,
): Promise<{ docs: Doc[]; capped: boolean; notFound: boolean }> {
  const docs: Doc[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < pages; i++) {
    const q = `limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    let page: { items?: Doc[]; nextCursor?: string | null } | null;
    try {
      page = (
        where
          ? await request(t, "POST", `${data(id, col)}/query`, {
              where,
              limit: PAGE_LIMIT,
              ...(cursor ? { cursor } : {}),
            })
          : await get(t, `${data(id, col)}?${q}`)
      ) as typeof page;
    } catch (e) {
      if (e instanceof TooLarge) return { docs, capped: true, notFound: false };
      throw e;
    }
    if (page === null && i === 0)
      return { docs, capped: false, notFound: true };
    for (const d of page?.items ?? [])
      if (d && typeof d.id === "string") docs.push(d);
    cursor = page?.nextCursor ?? null;
    if (!cursor) return { docs, capped: false, notFound: false };
  }
  return { docs, capped: true, notFound: false };
}

/**
 * Exact doc count from `GET /api/v1/artifacts/:id/data-count/:collection` -> `{ count }`, or
 * undefined on a 404 (endpoint absent, or no access: the caller then pages) or another
 * shape. Probed per metric on every tick, never cached.
 */
async function countApi(t: Ctx, id: string, col: string) {
  const r = (await get(t, `/api/v1/artifacts/${id}/data-count/${col}`)) as {
    count?: unknown;
  } | null;
  const n = r?.count;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : undefined;
}

type Sources = {
  votes: number;
  pixels: number;
  pins: number;
  countries: number;
  tictactoe: GameState;
  chess: GameState;
};

export async function tick(
  env: Env,
  opts: { now?: number; budget?: number } = {},
): Promise<void> {
  if (!isId(env.DASHBOARD_ARTIFACT_ID)) {
    console.error("demo-ops: invalid DASHBOARD_ARTIFACT_ID");
    return;
  }
  const now = opts.now ?? Date.now();
  const day = utcDay(now);
  const hour = new Date(now).getUTCHours();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TICK_DEADLINE_MS);
  const t: Ctx = {
    env,
    base: env.DEMO_BASE_URL.replace(/\/+$/, ""),
    signal: ctl.signal,
    budget: (opts.budget ?? MAX_REQUESTS) - WRITES,
    truncated: new Set(),
  };
  const missing: string[] = [];
  const failed: string[] = [];
  const noAccess: string[] = [];
  const ids = {
    poll: env.POLL_ID,
    canvas: env.CANVAS_ID,
    map: env.MAP_ID,
    tictactoe: env.TICTACTOE_ID,
    chess: env.CHESS_ID,
  };
  const usable = (name: keyof typeof ids): string | undefined => {
    const id = ids[name];
    if (id && isId(id)) return id;
    if (id) console.warn(`demo-ops: ignoring invalid ${name} id`);
    missing.push(name);
    return undefined;
  };
  /** A paged read that 404s means no access or no artifact: the source is missing, not 0. */
  const absent = (name: string) => {
    if (!missing.includes(name)) missing.push(name);
    noAccess.push(name);
  };
  const none: GameState = { moves: 0, inProgress: 0 };
  const s: Sources = {
    votes: 0,
    pixels: 0,
    pins: 0,
    countries: 0,
    tictactoe: none,
    chess: none,
  };
  /** Runs one source; an error or a spent budget makes it 0 and lists it in `failed`. */
  const source = async (
    name: string,
    id: string | undefined,
    fn: (id: string) => Promise<void>,
  ) => {
    if (!id) return;
    try {
      await fn(id);
    } catch (e) {
      failed.push(name);
      console.warn(
        `demo-ops: ${name} failed: ${e instanceof Error ? e.message : "error"}`,
      );
    }
  };

  let hourlyPrev: unknown;
  let hourlyOk = true;
  try {
    const poll = usable("poll");
    const canvas = usable("canvas");
    const map = usable("map");
    const ttt = usable("tictactoe");
    const chess = usable("chess");

    await source("votes", poll, async (id) => {
      const col = `votes-${day}`;
      const n = await countApi(t, id, col);
      if (n !== undefined) {
        s.votes = n;
        return;
      }
      const r = await listDocs(t, id, col);
      if (r.notFound) return absent("poll");
      s.votes = r.docs.length;
      if (r.capped) t.truncated.add("votes");
    });
    await source("pixels", canvas, async (id) => {
      const r = await listDocs(t, id, `canvas-${day}`, 1);
      if (r.notFound) return absent("canvas");
      s.pixels = pixelCount(r.docs);
      if (r.capped) t.truncated.add("pixels");
    });
    await source("pins", map, async (id) => {
      const col = `pins-${day}`;
      const exact = await countApi(t, id, col);
      const r = await listDocs(t, id, col);
      if (r.notFound) return absent("map");
      s.countries = countries(r.docs);
      s.pins = exact ?? r.docs.length;
      if (r.capped) {
        t.truncated.add("countries");
        if (exact === undefined) t.truncated.add("pins");
      }
    });
    await source("tictactoe", ttt, async (id) => {
      s.tictactoe = ticTacToeState(await getDoc(t, id, "game", "game"), now);
    });
    await source("chess", chess, async (id) => {
      const table = await getDoc(t, id, "table", "table");
      const g = (table as { g?: unknown } | undefined)?.g;
      if (typeof g !== "string") return;
      const r = await listDocs(t, id, "moves", MAX_PAGES, { g });
      if (r.notFound) return absent("chess");
      s.chess = chessState(table, r.docs, now);
      if (r.capped) t.truncated.add("moves.chess");
    });
    try {
      hourlyPrev = await getDoc(
        t,
        env.DASHBOARD_ARTIFACT_ID,
        "stats",
        `hourly-${day}`,
      );
    } catch {
      hourlyOk = false;
    }
  } finally {
    clearTimeout(timer);
  }

  if (noAccess.length)
    console.warn(
      `demo-ops: not found or no access: ${noAccess.join(", ")}; treated as missing`,
    );
  const today: TodayStats = {
    day,
    updatedAt: now,
    votes: s.votes,
    gamesInProgress: {
      tictactoe: s.tictactoe.inProgress,
      chess: s.chess.inProgress,
    },
    moves: { tictactoe: s.tictactoe.moves, chess: s.chess.moves },
    pixels: s.pixels,
    countries: s.countries,
    pins: s.pins,
    truncated: [...t.truncated],
    missing,
    failed,
  };
  await put(env, t.base, "today", today);
  // A failed source would make the write total dip and then rebound as fake writes.
  if (hourlyOk && !failed.length) {
    const total =
      s.votes + s.tictactoe.moves + s.chess.moves + s.pixels + s.pins;
    const next: Hourly = hourlyNext(hourlyPrev, day, hour, total);
    await put(env, t.base, `hourly-${day}`, next);
  }
}

/** One doc per call, with its own timeout (the tick's deadline must not cut the writes). */
async function put(
  env: Env,
  base: string,
  doc: string,
  body: unknown,
): Promise<void> {
  try {
    const res = await fetch(
      `${base}${data(env.DASHBOARD_ARTIFACT_ID, "stats", doc)}`,
      {
        method: "PUT",
        headers: headers(env),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok)
      console.error(`demo-ops: write stats/${doc} failed: ${res.status}`);
  } catch (e) {
    console.error(
      `demo-ops: write stats/${doc} failed: ${e instanceof Error ? e.message : "error"}`,
    );
  }
}

export default {
  async scheduled(_c: unknown, env: Env, _ctx: unknown): Promise<void> {
    await tick(env);
  },
  fetch(): Response {
    return new Response("not found", { status: 404 });
  },
};
