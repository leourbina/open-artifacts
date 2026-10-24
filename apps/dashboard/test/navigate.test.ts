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
  it.each(["https://other.example/x?q#h", "http://other.example/"])(
    "accepts %s",
    (u) => {
      expect(openableUrl(u)?.href).toBe(new URL(u).href);
    },
  );
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
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "\u0000https://other.example/",
    "https://other.example/\u0007x",
    "https://other.example/ x",
  ])("refuses %j", (u) => {
    expect(openableUrl(u)).toBeNull();
  });
});

describe("linkHost", () => {
  it.each([
    ["https://www.example.com/a", "example.com"],
    ["https://docs.example.com:8443/a", "docs.example.com:8443"],
    ["https://docs.example.com:443/a", "docs.example.com"],
    ["http://docs.example.com:80/a", "docs.example.com"],
    ["http://docs.example.com:8080/a", "docs.example.com:8080"],
    [
      "https://a-very-long-subdomain.with.many.parts.docs.example.com:8443/",
      "…any.parts.docs.example.com:8443",
    ],
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
      contentOrigin: () => "https://content.test",
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
    const [u, go] = ask.mock.calls[0] as [URL, () => void, () => void];
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

  it.each([
    "https://app.test/settings",
    "https://app.test/oauth/authorize?client_id=evil",
    "https://app.test/invite/abc",
    "https://app.test/?space=x",
    "https://app.test/a/B/edit",
    "https://content.test/c/token/B/v1/__view",
    "https://content.test/p/B/v1/index.html",
  ])("refuses the app's or content host's %s (not a viewer path)", (u) => {
    const { openLink, go, assign, ask, open } = setup({ active: false });
    openLink(u);
    expect(go).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    "http://app.test/oauth/authorize?client_id=evil",
    "http://app.test/settings",
    "https://app.test:8443/invite/abc",
    "http://app.test/?space=x",
    "http://content.test/p/B/v1/index.html",
    "https://content.test:8443/c/token/B/v1/__view",
    "http://app.test./oauth/authorize?client_id=evil",
    "https://app.test./settings",
    "https://content.test./p/B/v1/index.html",
  ])(
    "refuses %s: the app's or content host, whatever the scheme or port",
    (u) => {
      const { openLink, go, assign, ask, open } = setup({ active: true });
      openLink(u);
      expect(go).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
      expect(ask).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    },
  );

  it("a viewer path on the app host, any scheme or port, routes in place", () => {
    const { openLink, go, tick } = setup();
    openLink("http://app.test/a/B");
    tick(1000);
    openLink("https://app.test:8443/a/C/full");
    tick(1000);
    openLink("https://app.test./a/D");
    expect(go.mock.calls).toEqual([["/a/B"], ["/a/C/full"], ["/a/D"]]);
  });

  it.each(["dismissed", "timed out", "opened"])(
    "the prompt lock releases once the toast is %s: the next open asks again",
    (how) => {
      const { openLink, ask, tick } = setup({ active: false });
      openLink("https://other.example/one");
      const [, go, done] = ask.mock.calls[0] as [URL, () => void, () => void];
      // The toast's onDismiss/onAutoClose, or Open (which calls done, then go).
      if (how === "opened") {
        done();
        go();
      } else done();
      tick(1000);
      openLink("https://other.example/two");
      expect(ask).toHaveBeenCalledTimes(2);
      expect((ask.mock.calls[1] as [URL])[0].href).toBe(
        "https://other.example/two",
      );
    },
  );

  it("ignores opens while its prompt is showing, then accepts again", () => {
    const { openLink, assign, ask, tick } = setup({ active: false });
    openLink("https://other.example/first");
    tick(1000);
    openLink("https://other.example/swapped");
    expect(ask).toHaveBeenCalledTimes(1);
    const [, go, done] = ask.mock.calls[0] as [URL, () => void, () => void];
    done();
    tick(1000);
    openLink("https://other.example/later");
    expect(ask).toHaveBeenCalledTimes(2);
    go();
    expect(assign).toHaveBeenCalledWith("https://other.example/first");
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
