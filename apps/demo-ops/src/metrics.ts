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

const fresh = (at: number, now: number): boolean => now - at <= FRESH_MS;

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
    ...mine.map((m) => atOf(m.data) ?? Number.NEGATIVE_INFINITY),
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

export type Hourly = { h: number[]; lastTotal: number; lastDay: string };

const validHourly = (v: unknown, day: string): v is Hourly =>
  isObj(v) &&
  v.lastDay === day &&
  typeof v.lastTotal === "number" &&
  Number.isFinite(v.lastTotal) &&
  Array.isArray(v.h) &&
  v.h.length === 24 &&
  v.h.every((x) => Number.isInteger(x) && (x as number) >= 0);

/**
 * The next hourly doc: the change in the write total since the previous tick goes to
 * the current UTC hour (never negative). A missing, malformed or other-day doc is a
 * fresh baseline: nothing is added.
 */
export function hourlyNext(
  prev: unknown,
  day: string,
  hour: number,
  total: number,
): Hourly {
  if (!validHourly(prev, day))
    return { h: Array(24).fill(0), lastTotal: total, lastDay: day };
  const h = [...prev.h];
  h[hour] = (h[hour] as number) + Math.max(0, total - prev.lastTotal);
  return { h, lastTotal: total, lastDay: day };
}
