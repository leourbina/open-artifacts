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
  const H = 13;
  it("a fresh doc is a baseline: no delta", () => {
    expect(hourlyNext(undefined, "20261020", H, 40)).toEqual({
      h: Array(24).fill(0),
      lastTotal: 40,
      lastDay: "20261020",
    });
  });
  it("adds the positive delta to the current hour", () => {
    const prev = { h: Array(24).fill(0), lastTotal: 10, lastDay: "20261020" };
    const next = hourlyNext(prev, "20261020", H, 17);
    expect(next.h[H]).toBe(7);
    expect(next.lastTotal).toBe(17);
    expect(next.h.reduce((a, b) => a + b, 0)).toBe(7);
    // a second tick accumulates
    expect(hourlyNext(next, "20261020", H, 20).h[H]).toBe(10);
  });
  it("clamps a negative delta to zero but keeps the new baseline", () => {
    const prev = { h: Array(24).fill(0), lastTotal: 30, lastDay: "20261020" };
    prev.h[H] = 5;
    const next = hourlyNext(prev, "20261020", H, 12);
    expect(next.h[H]).toBe(5);
    expect(next.lastTotal).toBe(12);
  });
  it("resets on a day change", () => {
    const prev = { h: Array(24).fill(3), lastTotal: 99, lastDay: "20261019" };
    expect(hourlyNext(prev, "20261020", 0, 4)).toEqual({
      h: Array(24).fill(0),
      lastTotal: 4,
      lastDay: "20261020",
    });
  });
  it("repairs a malformed doc", () => {
    for (const bad of [
      {},
      { h: [1, 2], lastTotal: 1, lastDay: "20261020" },
      { h: "x" },
    ]) {
      const n = hourlyNext(bad, "20261020", H, 5);
      expect(n.h).toHaveLength(24);
      expect(n.lastTotal).toBe(5);
    }
  });
});
