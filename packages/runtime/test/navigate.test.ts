import type { ArtifactToShell } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../src/index.js";
import * as schemas from "../src/schemas.js";

const N = "AbCdEfGhIjKlMnOpQrSt_-";
const APP = "https://app.example";

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

let parent: { postMessage: ReturnType<typeof vi.fn> };
let ctl: AbortController;
const realParent = window.parent;
const navs = () =>
  parent.postMessage.mock.calls
    .map((c) => c[0] as ArtifactToShell)
    .filter((m) => m.type === "navigate");
const opens = () =>
  parent.postMessage.mock.calls
    .map((c) => c[0] as ArtifactToShell)
    .filter((m) => m.type === "open");
/** jsdom can't make a trusted event; tests flip what the runtime sees. */
let trusted = true;
const fromShell = (data: unknown) =>
  window.dispatchEvent(
    new MessageEvent("message", { data, source: parent as unknown as Window }),
  );
const welcome = async (appOrigin: string | null = APP) => {
  fromShell({
    oa: 1,
    type: "welcome",
    capabilities: { db: false, viewer: false, storage: false },
    viewer: null,
    theme: "light",
    ...(appOrigin ? { appOrigin } : {}),
  });
  await flush();
};
/** Clicks inside a fresh link; returns whether the runtime prevented it. */
const click = async (
  href: string,
  attrs: Record<string, string> = {},
  init: MouseEventInit = {},
) => {
  const a = document.createElement("a");
  a.href = href;
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  const span = document.createElement("span");
  a.append(span);
  document.body.append(a);
  let prevented = false;
  a.addEventListener("click", (ev) => {
    prevented = ev.defaultPrevented;
    // Keep the test document from navigating.
    ev.preventDefault();
  });
  span.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ...init,
    }),
  );
  a.remove();
  await flush();
  return prevented;
};

beforeEach(async () => {
  delete (window as unknown as Record<string, unknown>).__oaShellNonce;
  history.replaceState(null, "", `/p#oa=${N}`);
  ctl = new AbortController();
  parent = { postMessage: vi.fn() };
  Object.defineProperty(window, "parent", {
    value: parent,
    configurable: true,
  });
  trusted = true;
  createRuntime({
    loadSchemas: async () => schemas,
    signal: ctl.signal,
    isTrusted: () => trusted,
  });
  await flush();
});
afterEach(() => {
  ctl.abort();
  Object.defineProperty(window, "parent", {
    value: realParent,
    configurable: true,
  });
});

describe("oa:navigate", () => {
  it.each(["/a/abc_-1", "/a/abc/full", "/a/abc/v/12"])(
    "an app-origin %s link posts navigate with the nonce and is prevented",
    async (p) => {
      await welcome();
      expect(await click(`${APP}${p}?x=1#h`)).toBe(true);
      expect(navs()).toEqual([
        { oa: 1, type: "navigate", url: `${APP}${p}?x=1#h`, nonce: N },
      ]);
    },
  );

  it("_self target navigates too", async () => {
    await welcome();
    expect(await click(`${APP}/a/abc`, { target: "_self" })).toBe(true);
    expect(navs()).toHaveLength(1);
  });

  it.each([
    ["_blank target", `${APP}/a/abc`, { target: "_blank" }],
    ["named target", `${APP}/a/abc`, { target: "w" }],
    ["download", `${APP}/a/abc`, { download: "" }],
  ])("%s is untouched", async (_n, href, attrs) => {
    await welcome();
    expect(await click(href, attrs)).toBe(false);
    expect(navs()).toEqual([]);
  });

  it("a <base target> counts as the link's target", async () => {
    await welcome();
    const base = document.createElement("base");
    base.target = "_blank";
    document.head.append(base);
    expect(await click(`${APP}/a/abc`)).toBe(false);
    expect(await click("https://other.example/x")).toBe(false);
    base.remove();
    expect(navs()).toEqual([]);
    expect(opens()).toEqual([]);
  });

  it.each([
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ])("modifier or non-primary click %o is untouched", async (init) => {
    await welcome();
    expect(await click(`${APP}/a/abc`, {}, init)).toBe(false);
    expect(navs()).toEqual([]);
  });

  it("before welcome, or a welcome without appOrigin, is untouched", async () => {
    expect(await click(`${APP}/a/abc`)).toBe(false);
    await welcome(null);
    expect(await click(`${APP}/a/abc`)).toBe(false);
    expect(navs()).toEqual([]);
  });

  it("an already prevented click is untouched", async () => {
    await welcome();
    const stop = (e: Event) => e.preventDefault();
    window.addEventListener("click", stop, true);
    await click(`${APP}/a/abc`);
    window.removeEventListener("click", stop, true);
    expect(navs()).toEqual([]);
  });
});

describe("oa:open", () => {
  it.each([
    ["another origin", "https://other.example/a/abc?q=1#h"],
    ["http", "http://other.example/"],
  ])("%s posts open with the nonce and is prevented", async (_n, href) => {
    await welcome();
    expect(await click(href)).toBe(true);
    expect(opens()).toEqual([
      { oa: 1, type: "open", url: new URL(href).href, nonce: N },
    ]);
    expect(navs()).toEqual([]);
  });

  it("_self target opens too", async () => {
    await welcome();
    expect(await click("https://other.example/", { target: "_self" })).toBe(
      true,
    );
    expect(opens()).toHaveLength(1);
  });

  it.each([
    ["_blank target", "https://other.example/", { target: "_blank" }],
    ["named target", "https://other.example/", { target: "w" }],
    ["download", "https://other.example/f.zip", { download: "" }],
    ["the artifact's own pages", "/p/page2.html", {}],
    ["an in-page anchor", "#section", {}],
    ["mailto", "mailto:a@example.com", {}],
    ["javascript", "javascript:void(0)", {}],
    ["data", "data:text/html,hi", {}],
  ])("%s is untouched", async (_n, href, attrs) => {
    await welcome();
    expect(await click(href, attrs)).toBe(false);
    expect(opens()).toEqual([]);
  });

  it.each([
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ])("modifier or non-primary click %o is untouched", async (init) => {
    await welcome();
    expect(await click("https://other.example/", {}, init)).toBe(false);
    expect(opens()).toEqual([]);
  });

  it("a script's synthetic click is untouched", async () => {
    await welcome();
    trusted = false;
    expect(await click("https://other.example/")).toBe(false);
    expect(opens()).toEqual([]);
  });

  it("before welcome (no shell yet) is untouched", async () => {
    expect(await click("https://other.example/")).toBe(false);
    expect(opens()).toEqual([]);
  });
});

describe("app pages and other artifacts' content: blocked in place (#525)", () => {
  /** The frame's own document, as the content host serves it. */
  const at = (path: string) => history.replaceState(null, "", path);

  it.each([
    ["an app page", `${APP}/settings`],
    ["an app OAuth page", `${APP}/oauth/authorize?client_id=x`],
    ["a deeper /a/ path", `${APP}/a/abc/edit`],
    ["the app over http", "http://app.example/settings"],
    ["the app on another port", "https://app.example:8443/invite/x"],
    ["the app with a trailing dot", "https://app.example./settings"],
  ])(
    "%s: prevented, and the shell is told (it refuses and says why)",
    async (_n, href) => {
      await welcome();
      expect(await click(href)).toBe(true);
      expect(opens()).toEqual([
        { oa: 1, type: "open", url: new URL(href).href, nonce: N },
      ]);
    },
  );

  it.each([
    ["another artifact", "/p/Other45/v1/index.html"],
    ["another artifact, signed", "/c/tok/Other45/v1/index.html"],
    ["another version of this one", "/p/Own123/v2/index.html"],
  ])(
    "%s on the content host: prevented, and the shell is told",
    async (_n, path) => {
      at("/p/Own123/v3/index.html");
      await welcome();
      expect(await click(path)).toBe(true);
      expect(opens()).toHaveLength(1);
    },
  );

  it.each([
    ["a relative page", "page2.html"],
    ["a nested page", "docs/a.html"],
    ["an in-page anchor", "#top"],
  ])("this artifact's own %s still navigates the frame", async (_n, href) => {
    at("/p/Own123/v3/index.html");
    await welcome();
    expect(await click(href)).toBe(false);
    expect(opens()).toEqual([]);
  });

  it("a script's synthetic click on an app page is untouched", async () => {
    await welcome();
    trusted = false;
    expect(await click(`${APP}/settings`)).toBe(false);
    expect(opens()).toEqual([]);
  });
});
