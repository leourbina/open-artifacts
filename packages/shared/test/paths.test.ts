import { describe, expect, it } from "vitest";
import {
  findCaseCollision,
  normalizePath,
  type PathError,
} from "../src/paths.js";

const bad: [string, PathError][] = [
  ["", "empty"],
  [".", "empty"],
  ["/etc/passwd", "absolute"],
  ["../x", "traversal"],
  ["a/../../b", "traversal"],
  ["a/..", "traversal"],
  ["a\\b", "backslash"],
  ["a//b", "empty_segment"],
  ["a/", "empty_segment"],
  ["a\u0000b", "control_char"],
  ["a\x7fb", "control_char"],
  ["x".repeat(513), "too_long"],
  ["%2e%2e/x", "traversal"],
  ["a/%2E/b", "traversal"],
  ["a%2fb", "traversal"],
  ["a/x%2Fy", "traversal"],
  ["%2e", "traversal"],
];

describe("normalizePath", () => {
  for (const [input, error] of bad) {
    it(`rejects ${JSON.stringify(input.slice(0, 20))} as ${error}`, () => {
      expect(normalizePath(input)).toEqual({ ok: false, error });
    });
  }
  it("normalizes", () => {
    expect(normalizePath("./a/b.css")).toEqual({ ok: true, path: "a/b.css" });
    expect(normalizePath("a/./b")).toEqual({ ok: true, path: "a/b" });
    expect(normalizePath("100%.txt")).toEqual({ ok: true, path: "100%.txt" });
    expect(normalizePath("a%20b%2g")).toEqual({ ok: true, path: "a%20b%2g" });
    expect(normalizePath("x".repeat(512))).toEqual({
      ok: true,
      path: "x".repeat(512),
    });
  });
});

describe("findCaseCollision", () => {
  it("finds pair", () => {
    expect(findCaseCollision(["A.css", "b.css", "a.css"])).toEqual([
      "A.css",
      "a.css",
    ]);
  });
  it("null when none", () => {
    expect(findCaseCollision(["a", "b"])).toBeNull();
  });
});

describe("fix round 1: unicode", () => {
  it("returns NFC", () => {
    expect(normalizePath("cafe\u0301.txt")).toEqual({
      ok: true,
      path: "caf\u00e9.txt",
    });
  });
  it("rejects C1 and bidi", () => {
    for (const c of [
      "\u0085",
      "\u009f",
      "\u200e",
      "\u200f",
      "\u202a",
      "\u202e",
      "\u2066",
      "\u2069",
    ]) {
      expect(normalizePath(`a${c}b`)).toEqual({
        ok: false,
        error: "control_char",
      });
    }
  });
  it("case collisions use NFC + full case folding", () => {
    expect(findCaseCollision(["caf\u00e9", "cafe\u0301"])).not.toBeNull();
    expect(findCaseCollision(["stra\u00dfe", "STRASSE"])).not.toBeNull();
  });
});
