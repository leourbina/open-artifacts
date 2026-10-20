import type { ArtifactToShell } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RAW_VIEW_MESSAGE } from "../src/bridge.js";
import { createRuntime } from "../src/index.js";
import * as schemas from "../src/schemas.js";

const N = "AbCdEfGhIjKlMnOpQrSt_-";

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

let parent: { postMessage: ReturnType<typeof vi.fn> };
let ctl: AbortController;
const realParent = window.parent;
const sent = (): ArtifactToShell[] =>
  parent.postMessage.mock.calls.map((c) => c[0] as ArtifactToShell);
const fromShell = (data: unknown) =>
  window.dispatchEvent(
    new MessageEvent("message", { data, source: parent as unknown as Window }),
  );
const start = (opts: Parameters<typeof createRuntime>[0] = {}) =>
  createRuntime({
    loadSchemas: async () => schemas,
    signal: ctl.signal,
    ...opts,
  });
/** A fresh document load: the nonce is read once per document. */
const load = (url: string) => {
  delete (window as unknown as Record<string, unknown>).__oaShellNonce;
  history.replaceState(null, "", url);
};

beforeEach(() => {
  ctl = new AbortController();
  parent = { postMessage: vi.fn() };
  Object.defineProperty(window, "parent", {
    value: parent,
    configurable: true,
  });
});
afterEach(() => {
  ctl.abort();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(window, "parent", {
    value: realParent,
    configurable: true,
  });
  load("/");
});

describe("per-load nonce", () => {
  it("reads oa from the hash and strips it, keeping path, query and other fragment content", async () => {
    load(`/a/v1/index.html?x=1#section&oa=${N}`);
    start();
    expect(location.pathname).toBe("/a/v1/index.html");
    expect(location.search).toBe("?x=1");
    expect(location.hash).toBe("#section");
    await flush();
    expect(sent()[0]).toMatchObject({ type: "hello", nonce: N });
  });

  it("strips a lone #oa= to no hash at all", () => {
    load(`/p?q=2#oa=${N}`);
    start();
    expect(location.hash).toBe("");
    expect(location.search).toBe("?q=2");
  });

  it("ignores a malformed oa value and leaves the hash", async () => {
    load("/p#oa=short");
    start();
    expect(location.hash).toBe("#oa=short");
    await flush();
    expect(sent()[0]).not.toHaveProperty("nonce");
  });

  it("every outgoing message carries the nonce", async () => {
    load(`/p#oa=${N}`);
    const oa = start({
      loadSnapshot: async () => ({
        snapshot: async () => "data:image/webp;base64,AAAA",
      }),
    });
    void oa.viewer.get();
    void oa.db.collection("c").get("a");
    oa.db.collection("c").subscribe(() => {});
    await flush();
    fromShell({ oa: 1, type: "thumb.request" });
    await flush();
    const types = sent().map((m) => m.type);
    expect(types).toEqual(
      expect.arrayContaining(["hello", "call", "thumb.ready"]),
    );
    expect(sent().length).toBeGreaterThanOrEqual(5);
    for (const m of sent()) expect(m.nonce).toBe(N);
  });

  it("no nonce, top level: every call rejects at once with no_shell", async () => {
    load("/p");
    Object.defineProperty(window, "parent", {
      value: window,
      configurable: true,
    });
    const oa = start();
    await expect(oa.ready).resolves.toBeUndefined();
    await expect(oa.viewer.get()).rejects.toMatchObject({
      code: "no_shell",
      message: RAW_VIEW_MESSAGE,
    });
  });

  it("a throwing replaceState doesn't break boot: the hash stays, the nonce is still sent", async () => {
    load(`/p#x&oa=${N}`);
    vi.spyOn(history, "replaceState").mockImplementation(() => {
      throw new DOMException("sandboxed", "SecurityError");
    });
    const oa = start();
    expect(window.openArtifacts).toBeDefined();
    expect(location.hash).toBe(`#x&oa=${N}`);
    void oa.viewer.get();
    await flush();
    expect(sent().map((m) => m.type)).toEqual(["hello", "call"]);
    for (const m of sent()) expect(m.nonce).toBe(N);
  });
});
