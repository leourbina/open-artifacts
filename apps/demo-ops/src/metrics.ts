/** Pure metric functions for the demo dashboard feed. Unknown or malformed docs count as 0. */

export const FRESH_MS = 5 * 60_000;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A list item as the data API returns it. */
export type Doc = { id: string; data: unknown };

/** UTC day as YYYYMMDD. */
export const utcDay = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");

const atOf = (v: unknown): number | null => {
  if (!isObj(v)) return null;
  const at = v.at;
  if (typeof at === "number" && Number.isFinite(at)) return at;
  if (typeof at === "string") {
    const t = Date.parse(at);
    return Number.isNaN(t) ? null : t;
  }
  return null;
};

/** Within 5 minutes, and not more than 60 s ahead of us (clock skew; a bogus future stamp is not fresh). */
export const SKEW_MS = 60_000;
const fresh = (at: number, now: number): boolean =>
  now - at <= FRESH_MS && at <= now + SKEW_MS;

const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
] as const;

export type GameState = { moves: number; inProgress: 0 | 1 };

export function ticTacToeState(doc: unknown, now: number): GameState {
  if (!isObj(doc) || !Array.isArray(doc.board) || doc.board.length !== 9)
    return { moves: 0, inProgress: 0 };
  const b = doc.board as unknown[];
  const moves = b.filter((c) => c === "X" || c === "O").length;
  const won = LINES.some(
    ([i, j, k]) =>
      (b[i as number] === "X" || b[i as number] === "O") &&
      b[i as number] === b[j as number] &&
      b[j as number] === b[k as number],
  );
  const draw = moves === 9 && !won;
  const x = atOf(doc.x);
  const o = atOf(doc.o);
  const seated = x !== null && o !== null && fresh(x, now) && fresh(o, now);
  return { moves, inProgress: moves > 0 && !won && !draw && seated ? 1 : 0 };
}

const G_RE = /^g[A-Za-z0-9]{1,32}$/;

export function chessState(
  table: unknown,
  moves: Doc[],
  now: number,
): GameState {
  if (!isObj(table) || typeof table.g !== "string" || !G_RE.test(table.g))
    return { moves: 0, inProgress: 0 };
  const prefix = `${table.g}-`;
  const mine = moves.filter((m) => m.id.startsWith(prefix));
  const white = atOf(table.white);
  const black = atOf(table.black);
  if (!mine.length || white === null || black === null)
    return { moves: mine.length, inProgress: 0 };
  const newest = Math.max(
    white,
    black,
    // A move stamped in the future must not keep a stale game alive.
    ...mine.map((m) => {
      const at = atOf(m.data);
      return at !== null && at <= now + SKEW_MS ? at : Number.NEGATIVE_INFINITY;
    }),
  );
  return { moves: mine.length, inProgress: fresh(newest, now) ? 1 : 0 };
}

const ROW_RE = /^r(?:[0-2]\d|3[01])$/;
const CELL_RE = /^c(?:\d|[12]\d|3[01])$/;

/** Non-zero cN fields (N 0..31, integer values) over the docs r00..r31. */
export function pixelCount(docs: Doc[]): number {
  let n = 0;
  for (const d of docs) {
    if (!ROW_RE.test(d.id) || !isObj(d.data)) continue;
    for (const [k, v] of Object.entries(d.data))
      if (CELL_RE.test(k) && Number.isInteger(v) && v !== 0) n++;
  }
  return n;
}

/** Distinct ISO alpha-2 `c` values. */
export function countries(docs: Doc[]): number {
  const seen = new Set<string>();
  for (const d of docs) {
    const c = isObj(d.data) ? d.data.c : undefined;
    if (typeof c === "string" && /^[A-Z]{2}$/.test(c)) seen.add(c);
  }
  return seen.size;
}

export const METRICS = [
  "votes",
  "tictactoe",
  "chess",
  "pixels",
  "pins",
] as const;
export type Metric = (typeof METRICS)[number];
/** The current value of each metric that is available this tick (present, not truncated, not missing). */
export type Current = Partial<Record<Metric, number>>;
export type Hourly = {
  h: number[];
  /** Last value per metric; only metrics that were available that tick. */
  last: Partial<Record<Metric, number>>;
  lastDay: string;
};

export const HOURLY_CELL_MAX = 1e7;
export const DELTA_CAP = 5000;

const isNat = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

/** `h` is exactly 24 non-negative ints, each at most HOURLY_CELL_MAX. */
const validH = (v: unknown): v is number[] =>
  Array.isArray(v) &&
  v.length === 24 &&
  v.every((x) => isNat(x) && x <= HOURLY_CELL_MAX);

const validLast = (v: unknown): v is Hourly["last"] =>
  isObj(v) && Object.values(v).every(isNat);

/**
 * The next hourly doc. Each metric adds its own change since the last tick to the current
 * UTC hour (clamped at 0, capped at DELTA_CAP), but only when it is available now and was
 * in the previous doc: a metric that was down has no baseline when it returns, so there is
 * no spike. A missing doc, another day, or a bad `h` resets the day (fresh baseline, adds
 * nothing). A good `h` with bad `last` baselines keeps the history and only resets the
 * baselines. Returns null when there is nothing to write (a valid doc, no metric available).
 */
export function hourlyNext(
  prev: unknown,
  day: string,
  hour: number,
  cur: Current,
): Hourly | null {
  const last: Hourly["last"] = {};
  for (const m of METRICS) if (cur[m] !== undefined) last[m] = cur[m];
  if (!isObj(prev) || prev.lastDay !== day || !validH(prev.h))
    return { h: Array(24).fill(0), last, lastDay: day };
  if (!validLast(prev.last)) return { h: [...prev.h], last, lastDay: day };
  if (!Object.keys(last).length) return null;
  const h = [...prev.h];
  let add = 0;
  for (const m of METRICS) {
    const now = cur[m];
    const was = (prev.last as Hourly["last"])[m];
    if (now === undefined || was === undefined) continue;
    add += Math.min(DELTA_CAP, Math.max(0, now - was));
  }
  h[hour] = Math.min(HOURLY_CELL_MAX, (h[hour] as number) + add);
  return { h, last, lastDay: day };
}
