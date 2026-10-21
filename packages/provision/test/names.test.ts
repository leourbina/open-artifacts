import { describe, expect, it } from "vitest";
import { hosts, isInstallId, names, newInstallId } from "../src/index.js";

const D = { app: "app.test", content: "content.test" };

describe("provision names", () => {
  it("install ids are 12 chars, lowercase, i-prefixed", () => {
    for (let n = 0; n < 200; n++)
      expect(isInstallId(newInstallId())).toBe(true);
    expect(isInstallId("I0123456789a")).toBe(false);
  });
  it("names are derived only from the id", () => {
    expect(names("iabc123def45")).toEqual({
      script: "oa-iabc123def45",
      d1: "oa-iabc123def45",
      r2: "oa-iabc123def45",
      kv: "oa-iabc123def45-oauth",
    });
  });
  it("rejects reserved, uppercase, dotted and too-long slugs", () => {
    for (const s of [
      "www",
      "auth",
      "broker",
      "login",
      "sso",
      "Acme",
      "a.b",
      "-a",
      "a-",
      "x".repeat(33),
    ])
      expect(() => hosts(s, D)).toThrow(/slug/);
    expect(hosts("finqore", D)).toEqual({
      appHost: "finqore.app.test",
      contentHost: "finqore.content.test",
    });
  });
  it("refuses equal or nested app and content domains", () => {
    expect(() => hosts("a", { app: "x.test", content: "x.test" })).toThrow(
      /domain/,
    );
    expect(() => hosts("a", { app: "x.test", content: "c.x.test" })).toThrow(
      /domain/,
    );
    expect(() => hosts("a", { app: "c.x.test", content: "x.test" })).toThrow(
      /domain/,
    );
  });
});
