import { describe, expect, it, vi } from "vitest";
import { artifactNavPath, createNavigator } from "../src/viewer/navigate";

const O = "https://app.test";

describe("artifactNavPath", () => {
  it.each([
    ["https://app.test/a/x", "/a/x"],
    ["https://app.test/a/Ab_9-z/full", "/a/Ab_9-z/full"],
    ["https://app.test/a/x/v/3", "/a/x/v/3"],
    ["https://app.test/a/x?panel=open#top", "/a/x"],
    ["https://app.test:443/a/x", "/a/x"],
  ])("accepts %s", (url, path) => {
    expect(artifactNavPath(url, O)).toBe(path);
  });

  it.each([
    "https://evil.test/a/x",
    "http://app.test/a/x",
    "https://app.test:8443/a/x",
    "https://app.test.evil.test/a/x",
    "https://user:pw@app.test/a/x",
    "https://user@app.test/a/x",
    "https://app.test/settings",
    "https://app.test/a/x/diff",
    "https://app.test/a/x/v/abc",
    "https://app.test/a/x/v/",
    "https://app.test/a/x/",
    "https://app.test/a/",
    "https://app.test/a/x/full/more",
    "https://app.test/a/x%2Fy",
    "https://app.test/a/x/../../settings/x",
    "javascript:alert(1)",
    "//app.test/a/x",
    "/a/x",
    "data:text/html,hi",
    "",
  ])("rejects %s", (url) => {
    expect(artifactNavPath(url, O)).toBeNull();
  });
});

describe("createNavigator", () => {
  const setup = (embed = false) => {
    let t = 0;
    const go = vi.fn();
    const open = vi.fn();
    const nav = createNavigator(go, {
      origin: O,
      now: () => t,
      embed: () => embed,
      open,
    });
    return { nav, go, open, tick: (ms: number) => (t += ms) };
  };

  it("routes a valid URL to its path", () => {
    const { nav, go, open } = setup();
    nav("https://app.test/a/B?x=1#y");
    expect(go).toHaveBeenCalledWith("/a/B");
    expect(open).not.toHaveBeenCalled();
  });

  it("ignores an invalid URL silently, without spending the rate limit", () => {
    const { nav, go } = setup();
    nav("https://app.test/settings");
    nav("https://app.test/a/B");
    expect(go).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith("/a/B");
  });

  it("ignores a second navigate within 1 s", () => {
    const { nav, go, tick } = setup();
    nav("https://app.test/a/B");
    tick(999);
    nav("https://app.test/a/C");
    expect(go).toHaveBeenCalledTimes(1);
    tick(1);
    nav("https://app.test/a/C");
    expect(go).toHaveBeenLastCalledWith("/a/C");
    expect(go).toHaveBeenCalledTimes(2);
  });

  it("in embed mode opens a new tab and never routes", () => {
    const { nav, go, open } = setup(true);
    nav("https://app.test/a/B/full?q#h");
    expect(open).toHaveBeenCalledWith("https://app.test/a/B/full");
    expect(go).not.toHaveBeenCalled();
  });

  it("the default opener uses noopener", () => {
    const w = vi.fn();
    vi.stubGlobal("window", { open: w });
    try {
      createNavigator(vi.fn(), { origin: O, embed: () => true })(
        "https://app.test/a/B",
      );
      expect(w).toHaveBeenCalledWith(
        "https://app.test/a/B",
        "_blank",
        "noopener",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
