import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  activeGates,
  GATES,
  type GateId,
  isPlaceholder,
  servesOAuth,
} from "../src/lib/release";

// Each unshipped feature has its own automatic gate; an active gate marks the
// pages that describe the feature with a TODO comment and OA-UNRELEASED.
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const read = (p: string) => readFileSync(`${dist}${p}`, "utf8");
const file = (page: string) =>
  page === "index"
    ? "index.html"
    : page === "llms"
      ? "llms.txt"
      : `docs/${page}/index.html`;
const META = '<meta name="oa-status" content="OA-UNRELEASED">';

describe("feature gates", () => {
  it("detects the OAuth provider import", () => {
    expect(servesOAuth(['import { x } from "./y";'])).toBe(false);
    expect(
      servesOAuth([
        'import OAuthProvider from "@cloudflare/workers-oauth-provider";',
      ]),
    ).toBe(true);
  });

  it("detects placeholder dashboard pages", () => {
    const router = `gated("/settings/agents", A, "/", page("Agents")),
      <Placeholder title="Usage" />`;
    expect(isPlaceholder(router, "Agents")).toBe(true);
    expect(isPlaceholder(router, "Usage")).toBe(true);
    expect(
      isPlaceholder('gated("/settings/agents", A, "/", Agents)', "Agents"),
    ).toBe(false);
  });

  it("marks exactly the pages each active gate covers", () => {
    for (const id of Object.keys(GATES) as GateId[]) {
      for (const page of GATES[id].pages) {
        const text = read(file(page));
        expect(text.includes(GATES[id].todo), `${id} on ${page}`).toBe(
          activeGates[id],
        );
        if (activeGates[id])
          expect(text, `${id} on ${page}`).toContain(
            page === "llms" ? "OA-UNRELEASED:" : META,
          );
      }
    }
  });

  it("names every active llms gate on the OA-UNRELEASED line", () => {
    const line = read("llms.txt").match(/^OA-UNRELEASED: (.*)$/m)?.[1] ?? "";
    const want = (Object.keys(GATES) as GateId[])
      .filter(
        (id) =>
          activeGates[id] &&
          (GATES[id].pages as readonly string[]).includes("llms"),
      )
      .map((id) => GATES[id].label);
    expect(line ? line.split(", ") : []).toEqual(want);
  });
});
