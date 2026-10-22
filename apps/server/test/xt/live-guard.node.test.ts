import { describe, expect, it } from "vitest";
import { checkHealth, stagingOrigin } from "./live-guard.js";

describe("stagingOrigin", () => {
  it.each([
    "https://stg-a.open-artifacts.com",
    "https://rl-b.hosted.example.net/",
    "https://staging.open-artifacts.com",
    "https://staging-content.open-artifacts.com",
  ])("allows %s", (o) => {
    expect(stagingOrigin(o)).toBe(new URL(o).origin);
  });

  it.each([
    "http://stg-a.open-artifacts.com",
    "https://open-artifacts.com",
    "https://app.open-artifacts.com",
    "https://artifacts.leourbina.com",
    "https://prod-stg-a.open-artifacts.com",
    "https://stg-a.prod.open-artifacts.com",
    "https://stg-a.production.example.com",
    "https://staging.open-artifacts.com:8443",
    "https://u:p@stg-a.open-artifacts.com",
    "https://stg-a.open-artifacts.com/path",
    "https://localhost",
    "not a url",
  ])("refuses %s", (o) => {
    expect(() => stagingOrigin(o)).toThrow(/staging allowlist|not a URL/);
  });
});

describe("checkHealth", () => {
  const h = (b: unknown) => (typeof b === "string" ? b : JSON.stringify(b));
  const ok = { ok: true, testHooks: true, installId: "a" };

  it("passes two hook-enabled installs with distinct ids", () => {
    expect(() =>
      checkHealth(h(ok), h({ ...ok, installId: "b" })),
    ).not.toThrow();
  });

  it.each([
    ["hooks off at B", ok, { ok: true, installId: "b" }, /testHooks/],
    ["no installId", ok, { ok: true, testHooks: true }, /installId/],
    ["same installId", ok, ok, /distinct/],
    ["not JSON", ok, "<html>", /not JSON/],
    ["a JSON array", ok, "[]", /not a JSON object/],
  ])("refuses %s", (_n, a, b, msg) => {
    expect(() => checkHealth(h(a), h(b))).toThrow(msg);
  });
});
