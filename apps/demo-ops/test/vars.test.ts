import { describe, expect, it, vi } from "vitest";
import { deployVars, MAPPING } from "../scripts/vars.ts";

const ID = (c: string) => `${c}1b2c3d4E5f6g7h8`;

describe("deployVars", () => {
  it("maps ids.json slugs to the id vars", () => {
    expect(MAPPING).toEqual({
      poll: "POLL_ID",
      pixels: "CANVAS_ID",
      map: "MAP_ID",
      tictactoe: "TICTACTOE_ID",
      chess: "CHESS_ID",
      dashboard: "DASHBOARD_ARTIFACT_ID",
    });
    const text = JSON.stringify({
      poll: ID("P"),
      pixels: ID("C"),
      map: ID("M"),
      tictactoe: ID("T"),
      chess: ID("H"),
      dashboard: ID("D"),
    });
    expect(deployVars(text)).toEqual([
      `POLL_ID:${ID("P")}`,
      `CANVAS_ID:${ID("C")}`,
      `MAP_ID:${ID("M")}`,
      `TICTACTOE_ID:${ID("T")}`,
      `CHESS_ID:${ID("H")}`,
      `DASHBOARD_ARTIFACT_ID:${ID("D")}`,
    ]);
  });

  it("a missing slug passes an empty value", () => {
    const v = deployVars(JSON.stringify({ poll: ID("P") }));
    expect(v).toContain(`POLL_ID:${ID("P")}`);
    expect(v).toContain("CHESS_ID:");
    expect(v.filter((x) => x.endsWith(":"))).toHaveLength(5);
    expect(v).toHaveLength(6);
  });

  it("a missing ids.json passes every value empty", () => {
    expect(deployVars(undefined).every((x) => x.endsWith(":"))).toBe(true);
    expect(deployVars(undefined)).toHaveLength(6);
  });

  it("validates each id with isId; an invalid one is passed empty", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const v = deployVars(
      JSON.stringify({
        poll: "../x",
        pixels: "l0O0l0O0l0O0l0O0", // base58 excludes 0, O, I, l
        map: 7,
        tictactoe: `${ID("T")} --var X:1`,
        chess: ID("H"),
      }),
    );
    expect(v).toContain("POLL_ID:");
    expect(v).toContain("CANVAS_ID:");
    expect(v).toContain("MAP_ID:");
    expect(v).toContain("TICTACTOE_ID:");
    expect(v).toContain(`CHESS_ID:${ID("H")}`);
  });

  it("ignores unknown slugs and survives malformed JSON", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      deployVars(JSON.stringify({ gallery: ID("G") })).every((x) =>
        x.endsWith(":"),
      ),
    ).toBe(true);
    expect(deployVars("not json").every((x) => x.endsWith(":"))).toBe(true);
    expect(deployVars("[]").every((x) => x.endsWith(":"))).toBe(true);
  });
});
