import { describe, expect, it, vi } from "vitest";
import {
  artifactNavPath,
  createLimiter,
  createNavigator,
  createOpener,
  linkHost,
  openableUrl,
} from "../src/viewer/navigate";

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

describe("openableUrl", () => {
  it.each([
    "https://other.example/x?q#h",
    "http://other.example/",
    "https://app.test/settings",
  ])("accepts %s", (u) => {
    expect(openableUrl(u)?.href).toBe(new URL(u).href);
  });
  it.each([
    "javascript:alert(1)",
    "data:text/html,hi",
    "blob:https://other.example/1",
    "file:///etc/passwd",
    "mailto:a@example.com",
    "https://user:pw@other.example/",
    "https://user@other.example/",
    "not a url",
    "/relative",
  ])("refuses %s", (u) => {
    expect(openableUrl(u)).toBeNull();
  });
});

describe("linkHost", () => {
  it.each([
    ["https://www.example.com/a", "example.com"],
    ["https://docs.example.com:8443/a", "docs.example.com"],
    ["https://xn--bcher-kva.example/", "xn--bcher-kva.example"],
    ["https://bücher.example/", "xn--bcher-kva.example"],
    [
      "https://a-very-long-subdomain.with.many.parts.docs.example.com/",
      "…ith.many.parts.docs.example.com",
    ],
  ])("%s reads %s", (u, host) => {
    expect(linkHost(new URL(u))).toBe(host);
  });
});

describe("createOpener", () => {
  const setup = (o: { embed?: boolean; active?: boolean } = {}) => {
    let t = 0;
    const now = () => t;
    const go = vi.fn();
    const assign = vi.fn();
    const open = vi.fn();
    const ask = vi.fn();
    const limit = createLimiter(now);
    const openLink = createOpener({
      origin: O,
      go,
      assign,
      open,
      ask,
      limit,
      embed: () => o.embed ?? false,
      active: () => o.active ?? true,
    });
    return {
      openLink,
      go,
      assign,
      open,
      ask,
      limit,
      tick: (ms: number) => (t += ms),
    };
  };

  it("with user activation, navigates the top window in the same tab", () => {
    const { openLink, assign, ask } = setup();
    openLink("https://other.example/x");
    expect(assign).toHaveBeenCalledWith("https://other.example/x");
    expect(ask).not.toHaveBeenCalled();
  });

  it("without user activation, asks instead; Open then navigates", () => {
    const { openLink, assign, ask } = setup({ active: false });
    openLink("https://other.example/x");
    expect(assign).not.toHaveBeenCalled();
    expect(ask).toHaveBeenCalledTimes(1);
    const [u, go] = ask.mock.calls[0] as [URL, () => void];
    expect(u.href).toBe("https://other.example/x");
    go();
    expect(assign).toHaveBeenCalledWith("https://other.example/x");
  });

  it("refuses javascript:, data:, credentials and junk silently, without spending the limit", () => {
    const { openLink, assign, ask } = setup();
    for (const u of [
      "javascript:alert(1)",
      "data:text/html,x",
      "https://u:p@other.example/",
      "nope",
    ])
      openLink(u);
    expect(assign).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    openLink("https://other.example/");
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("shares the 1/s limit with navigate", () => {
    const { openLink, assign, limit, tick } = setup();
    const go = vi.fn();
    const nav = createNavigator(go, { origin: O, limit, embed: () => false });
    nav("https://app.test/a/B");
    openLink("https://other.example/");
    expect(assign).not.toHaveBeenCalled();
    tick(1000);
    openLink("https://other.example/");
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("an app viewer link routes in place, like navigate", () => {
    const { openLink, go, assign } = setup();
    openLink("https://app.test/a/B?x#y");
    expect(go).toHaveBeenCalledWith("/a/B");
    expect(assign).not.toHaveBeenCalled();
  });

  it("in embed mode opens a new tab", () => {
    const { openLink, open, assign, ask } = setup({
      embed: true,
      active: false,
    });
    openLink("https://other.example/x");
    expect(open).toHaveBeenCalledWith("https://other.example/x");
    expect(assign).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });
});
