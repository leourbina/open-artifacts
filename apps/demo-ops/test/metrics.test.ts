import { describe, expect, it } from "vitest";
import {
  chessState,
  countries,
  hourlyNext,
  pixelCount,
  ticTacToeState,
  utcDay,
} from "../src/metrics.js";

const NOW = Date.UTC(2026, 9, 20, 13, 30, 0);
const MIN = 60_000;
const seat = (ago: number, id = "u") => ({ id, at: NOW - ago });
const ttt = (board: string, x: unknown, o: unknown) => ({
  board: board.split("").map((c) => (c === "." ? "" : c)),
  x,
  o,
});

describe("utcDay", () => {
  it("formats the UTC day", () => {
    expect(utcDay(Date.UTC(2026, 0, 5, 23, 59, 59))).toBe("20260105");
    expect(utcDay(Date.UTC(2026, 11, 31, 0, 0, 0))).toBe("20261231");
  });
});

describe("ticTacToeState", () => {
  it("counts moves and is in progress with two fresh seats", () => {
    expect(
      ticTacToeState(ttt("XO.......", seat(1000), seat(1000)), NOW),
    ).toEqual({
      moves: 2,
      inProgress: 1,
    });
  });
  it("is not in progress with no moves", () => {
    expect(ticTacToeState(ttt(".........", seat(0), seat(0)), NOW)).toEqual({
      moves: 0,
      inProgress: 0,
    });
  });
  it("detects every winning line", () => {
    const lines = [
      "XXXOO....",
      "...XXXOO.",
      "......XXX",
      "X..X..X.O",
      ".X..X..X.",
      "..X..X..X",
      "X...X...X",
      "..X.X.X..",
    ];
    for (const b of lines) {
      const padded = b;
      const r = ticTacToeState(ttt(padded, seat(0), seat(0)), NOW);
      expect(r.inProgress, b).toBe(0);
    }
  });
  it("a winner by O ends the game too", () => {
    expect(
      ticTacToeState(ttt("OOOXX.X..", seat(0), seat(0)), NOW).inProgress,
    ).toBe(0);
  });
  it("a full board without a winner is a draw", () => {
    const r = ticTacToeState(ttt("XOXXOOOXX", seat(0), seat(0)), NOW);
    expect(r).toEqual({ moves: 9, inProgress: 0 });
  });
  it("a missing seat means not in progress", () => {
    expect(
      ticTacToeState(ttt("X........", seat(0), null), NOW).inProgress,
    ).toBe(0);
    expect(
      ticTacToeState(ttt("X........", null, seat(0)), NOW).inProgress,
    ).toBe(0);
  });
  it("seat staleness: exactly 5 minutes is fresh, one ms more is stale, for each seat", () => {
    expect(
      ticTacToeState(ttt("X........", seat(5 * MIN), seat(5 * MIN)), NOW)
        .inProgress,
    ).toBe(1);
    expect(
      ticTacToeState(ttt("X........", seat(5 * MIN + 1), seat(0)), NOW)
        .inProgress,
    ).toBe(0);
    expect(
      ticTacToeState(ttt("X........", seat(0), seat(5 * MIN + 1)), NOW)
        .inProgress,
    ).toBe(0);
  });
  it("clock skew: a seat up to 60 s in the future is fresh, 60 s + 1 ms is not", () => {
    const ahead = (ms: number) => ({ id: "u", at: NOW + ms });
    expect(
      ticTacToeState(ttt("X........", ahead(60_000), ahead(60_000)), NOW)
        .inProgress,
    ).toBe(1);
    expect(
      ticTacToeState(ttt("X........", ahead(60_001), seat(0)), NOW).inProgress,
    ).toBe(0);
    expect(
      ticTacToeState(ttt("X........", seat(0), ahead(60_001)), NOW).inProgress,
    ).toBe(0);
  });
  it("treats a bad or missing doc as zero", () => {
    for (const d of [null, undefined, {}, { board: "x" }, { board: [1, 2] }])
      expect(ticTacToeState(d, NOW)).toEqual({ moves: 0, inProgress: 0 });
  });
});

describe("chessState", () => {
  const table = (g: string, w: unknown, b: unknown) => ({
    g,
    white: w,
    black: b,
  });
  const mv = (g: string, n: number, ago: number) => ({
    id: `${g}-${String(n).padStart(3, "0")}`,
    data: { g, n, m: "e4", by: "u", at: NOW - ago },
  });
  it("counts only moves of the current game id prefix", () => {
    const moves = [
      mv("g7", 1, 1000),
      mv("g7", 2, 900),
      mv("g70", 1, 10),
      mv("g6", 1, 10),
    ];
    // g70 starts with "g7" but not with "g7-"
    expect(chessState(table("g7", seat(0), seat(0)), moves, NOW).moves).toBe(2);
  });
  it("is in progress with moves, both seats, and recent activity", () => {
    const r = chessState(
      table("g1", seat(9 * MIN), seat(9 * MIN)),
      [mv("g1", 1, MIN)],
      NOW,
    );
    expect(r).toEqual({ moves: 1, inProgress: 1 });
  });
  it("activity is the max of the newest move and the latest seat", () => {
    // moves old, a seat is fresh
    expect(
      chessState(
        table("g1", seat(0), seat(9 * MIN)),
        [mv("g1", 1, 9 * MIN)],
        NOW,
      ).inProgress,
    ).toBe(1);
    // seats old, a move is fresh
    expect(
      chessState(
        table("g1", seat(9 * MIN), seat(9 * MIN)),
        [mv("g1", 1, 0)],
        NOW,
      ).inProgress,
    ).toBe(1);
  });
  it("staleness boundary: exactly 5 minutes is fresh, one ms more is stale", () => {
    expect(
      chessState(
        table("g1", seat(5 * MIN), seat(9 * MIN)),
        [mv("g1", 1, 9 * MIN)],
        NOW,
      ).inProgress,
    ).toBe(1);
    expect(
      chessState(
        table("g1", seat(5 * MIN + 1), seat(9 * MIN)),
        [mv("g1", 1, 5 * MIN + 1)],
        NOW,
      ).inProgress,
    ).toBe(0);
  });
  it("clock skew: future activity beyond 60 s is not fresh and a bogus move is ignored", () => {
    const ahead = (ms: number) => ({ id: "u", at: NOW + ms });
    expect(
      chessState(
        table("g1", ahead(60_000), seat(9 * MIN)),
        [mv("g1", 1, 9 * MIN)],
        NOW,
      ).inProgress,
    ).toBe(1);
    expect(
      chessState(
        table("g1", ahead(60_001), seat(9 * MIN)),
        [mv("g1", 1, 9 * MIN)],
        NOW,
      ).inProgress,
    ).toBe(0);
    // a move stamped far in the future must not keep a stale game alive
    const bogus = { id: "g1-002", data: { at: NOW + 3_600_000 } };
    expect(
      chessState(
        table("g1", seat(9 * MIN), seat(9 * MIN)),
        [mv("g1", 1, 9 * MIN), bogus],
        NOW,
      ).inProgress,
    ).toBe(0);
  });
  it("needs moves and both seats", () => {
    expect(chessState(table("g1", seat(0), seat(0)), [], NOW).inProgress).toBe(
      0,
    );
    expect(
      chessState(table("g1", seat(0), null), [mv("g1", 1, 0)], NOW).inProgress,
    ).toBe(0);
  });
  it("a missing or invalid table is zero", () => {
    for (const t of [null, undefined, {}, { g: "../x" }, { g: 5 }])
      expect(chessState(t, [mv("g1", 1, 0)], NOW)).toEqual({
        moves: 0,
        inProgress: 0,
      });
  });
});

describe("pixelCount", () => {
  const row = (id: string, data: unknown) => ({ id, data });
  it("counts non-zero cN fields exactly, over r00..r31 only", () => {
    const docs = [
      row("r00", { c0: 1, c1: 0, c31: 5 }),
      row("r31", { c0: 2, c5: 0 }),
      row("r32", { c0: 9 }), // not a canvas row
      row("rows", { c0: 9 }),
      row("r01", { c32: 9, cx: 9, c0: "1", c2: -1, c3: 1.5, c4: 3 }),
    ];
    // r00: c0,c31 = 2; r31: c0 = 1; r01: only c4 (c2 negative is non-zero int? see below)
    expect(pixelCount(docs)).toBe(2 + 1 + 2);
  });
  it("is zero for no docs and ignores non-object data", () => {
    expect(pixelCount([])).toBe(0);
    expect(pixelCount([row("r00", null), row("r01", "x")])).toBe(0);
  });
});

describe("countries", () => {
  it("counts only distinct valid ISO alpha-2 values", () => {
    const docs = ["US", "US", "FR", "us", "USA", "", "1A", null, 5, "DE"].map(
      (c, i) => ({ id: `p${i}`, data: { c } }),
    );
    expect(countries(docs)).toBe(3);
  });
  it("ignores docs with no c", () => {
    expect(
      countries([
        { id: "a", data: {} },
        { id: "b", data: null },
      ]),
    ).toBe(0);
  });
});

describe("hourlyNext", () => {
  const D = "20261020";
  const H = 13;
  const zero = () => Array(24).fill(0);
  const cur = { votes: 10, tictactoe: 3, chess: 2, pixels: 4, pins: 5 };
  const doc = (last: Record<string, number>, h = zero()) => ({
    h,
    last,
    lastDay: D,
  });
  const sum = (n: { h: number[] } | null) =>
    (n?.h ?? []).reduce((a, b) => a + b, 0);

  it("a fresh doc is a baseline: no delta, last = the available metrics", () => {
    expect(hourlyNext(undefined, D, H, cur)).toEqual({
      h: zero(),
      last: cur,
      lastDay: D,
    });
  });

  it("sums the per-metric deltas into the current hour and accumulates", () => {
    const prev = doc({ votes: 8, tictactoe: 3, chess: 0, pixels: 4, pins: 4 });
    const n = hourlyNext(prev, D, H, cur);
    expect(n?.h[H]).toBe(2 + 0 + 2 + 0 + 1);
    expect(n?.last).toEqual(cur);
    expect(hourlyNext(n, D, H, { ...cur, votes: 11 })?.h[H]).toBe(6);
  });

  it("clamps each metric at 0: a drop in one never offsets a rise in another", () => {
    const prev = doc({ votes: 20, tictactoe: 3, chess: 2, pixels: 4, pins: 2 });
    const n = hourlyNext(prev, D, H, cur); // votes -10, pins +3
    expect(n?.h[H]).toBe(3);
    expect(n?.last.votes).toBe(10);
  });

  it("caps each metric at 5000 per tick", () => {
    const prev = doc({ votes: 0, pixels: 0 });
    const n = hourlyNext(prev, D, H, { votes: 99_999, pixels: 5000 });
    expect(n?.h[H]).toBe(5000 + 5000);
  });

  it("an unavailable metric adds nothing now and has no baseline when it returns", () => {
    const prev = doc({ votes: 5, pins: 5 });
    const down = hourlyNext(prev, D, H, { pins: 6 }); // votes unavailable
    expect(down?.h[H]).toBe(1);
    expect(down?.last).toEqual({ pins: 6 });
    const back = hourlyNext(down, D, H, { votes: 50, pins: 7 });
    expect(back?.h[H]).toBe(1 + 1); // votes has no baseline: only pins adds
    expect(back?.last).toEqual({ votes: 50, pins: 7 });
  });

  it("a metric with no baseline in the previous doc adds nothing", () => {
    const n = hourlyNext(doc({ pins: 1 }), D, H, { pins: 2, votes: 9 });
    expect(n?.h[H]).toBe(1);
  });

  it("returns null when every metric is unavailable and the doc is valid", () => {
    expect(hourlyNext(doc({ votes: 1 }), D, H, {})).toBeNull();
  });

  it("with every metric unavailable, an invalid doc is still replaced by a fresh baseline", () => {
    expect(hourlyNext({ h: [1] }, D, H, {})).toEqual({
      h: zero(),
      last: {},
      lastDay: D,
    });
  });

  it("resets on a day change", () => {
    const prev = {
      h: Array(24).fill(3),
      last: { votes: 99 },
      lastDay: "20261019",
    };
    expect(hourlyNext(prev, D, 0, { votes: 4 })).toEqual({
      h: zero(),
      last: { votes: 4 },
      lastDay: D,
    });
  });

  it("treats an invalid doc as fresh (adds 0, overwritten)", () => {
    const good = () => doc({ votes: 1 });
    const bad: unknown[] = [
      {},
      "x",
      { ...good(), h: Array(25).fill(0) },
      { ...good(), h: Array(23).fill(0) },
      { ...good(), h: zero().map((_, i) => (i === 3 ? -1 : 0)) },
      { ...good(), h: zero().map((_, i) => (i === 3 ? 1.5 : 0)) },
      { ...good(), h: zero().map((_, i) => (i === 3 ? 1e7 + 1 : 0)) },
      { ...good(), last: { votes: -1 } },
      { ...good(), last: { votes: 1.5 } },
      { ...good(), last: { votes: Number.NaN } },
      { ...good(), last: "x" },
      { ...good(), last: null },
    ];
    for (const b of bad) {
      const n = hourlyNext(b, D, H, { votes: 500 });
      expect(n, JSON.stringify(b)).toEqual({
        h: zero(),
        last: { votes: 500 },
        lastDay: D,
      });
    }
    // 1e7 itself is allowed
    const edge = { ...good(), h: zero().map((_, i) => (i === 3 ? 1e7 : 0)) };
    expect(hourlyNext(edge, D, H, { votes: 2 })?.h[3]).toBe(1e7);
  });

  it("sum helper sanity", () => {
    expect(sum(hourlyNext(doc({ votes: 1 }), D, H, { votes: 3 }))).toBe(2);
  });
});
