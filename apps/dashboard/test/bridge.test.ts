import { type ArtifactSummary, R } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridge } from "../src/viewer/bridge";

const ART = {
  id: "art1",
  title: "T",
  capabilities: { db: true, viewer: true, storage: false },
} as unknown as ArtifactSummary;
const VIEWER = { email: "a@b.c", name: "A" };
const DOC = { id: "d1", data: { x: 1 }, updatedAt: "now", updatedBy: null };

class FakeWS {
  static all: FakeWS[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  close() {
    this.closed = true;
  }
}

let win = new EventTarget();
const live: { dispose(): void }[] = [];
const post = vi.fn();
const contentWindow = { postMessage: post };
const iframe = { contentWindow } as unknown as HTMLIFrameElement;
let fetchMock: ReturnType<typeof vi.fn>;

const send = (data: unknown, o: { source?: unknown; origin?: string } = {}) => {
  const ev = new Event("message");
  Object.assign(ev, {
    data,
    source: "source" in o ? o.source : contentWindow,
    origin: o.origin ?? "null",
  });
  win.dispatchEvent(ev);
};
const flush = () => new Promise((r) => setTimeout(r, 0));
const call = (method: string, params: unknown, id = "c1") =>
  send({ oa: 1, type: "call", id, method, params });
const mk = (art = ART) => {
  const b = mkRaw(art);
  live.push(b);
  return b;
};
const mkRaw = (art: ArtifactSummary) =>
  createBridge({
    iframe,
    artifact: art,
    version: 1,
    viewer: VIEWER,
    theme: "light",
    onPdfText: vi.fn(),
    onThumb: vi.fn(),
  });
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status });

beforeEach(() => {
  FakeWS.all = [];
  win = new EventTarget();
  post.mockReset();
  fetchMock = vi.fn(async () => json(DOC));
  vi.stubGlobal("window", win);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("WebSocket", FakeWS);
  vi.stubGlobal("location", { protocol: "https:", host: "app.test" });
});
afterEach(() => {
  for (const b of live.splice(0)) b.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("bridge message gating", () => {
  it("ignores messages from window or another iframe", async () => {
    mk();
    call("db.get", { collection: "c", id: "d1" }, "a");
    call("db.get", { collection: "c", id: "d1" }, "b");
    send(
      { oa: 1, type: "call", id: "x", method: "db.get", params: {} },
      { source: window },
    );
    send(
      { oa: 1, type: "call", id: "y", method: "db.get", params: {} },
      { source: { postMessage: vi.fn() } },
    );
    await flush();
    expect(post.mock.calls.map((c) => c[0].id)).not.toContain("x");
    expect(post.mock.calls.map((c) => c[0].id)).not.toContain("y");
  });

  it("forged sources get no fetch and no reply", async () => {
    mk();
    send(
      {
        oa: 1,
        type: "call",
        id: "x",
        method: "db.get",
        params: { collection: "c", id: "d" },
      },
      { source: window },
    );
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("ignores origin !== 'null'", async () => {
    mk();
    send(
      { oa: 1, type: "hello", protocol: 1, kind: "html" },
      { origin: "https://evil" },
    );
    await flush();
    expect(post).not.toHaveBeenCalled();
  });

  it("drops malformed messages silently", async () => {
    mk();
    send({ oa: 1, type: "call", id: "1", method: "nope", params: {} });
    send("garbage");
    await flush();
    expect(post).not.toHaveBeenCalled();
  });

  it("dispose removes the listener", async () => {
    const b = mk();
    b.dispose();
    send({ oa: 1, type: "hello", protocol: 1, kind: "html" });
    await flush();
    expect(post).not.toHaveBeenCalled();
  });
});

describe("hello / welcome", () => {
  it("sends viewer when capability set, targeting '*'", () => {
    mk();
    send({ oa: 1, type: "hello", protocol: 1, kind: "html" });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "welcome",
        viewer: VIEWER,
        theme: "light",
      }),
      "*",
    );
  });

  it("viewer is null when capabilities.viewer is false", () => {
    mk({ ...ART, capabilities: { db: true, viewer: false, storage: false } });
    send({ oa: 1, type: "hello", protocol: 1, kind: "html" });
    expect(post.mock.calls[0]?.[0].viewer).toBeNull();
  });

  it("viewer.get mirrors the same rule", async () => {
    mk({ ...ART, capabilities: { db: true, viewer: false, storage: false } });
    call("viewer.get", {});
    await flush();
    // capability denied: viewer not declared
    expect(post.mock.calls[0]?.[0].error.code).toBe("capability_denied");
  });
});

describe("calls", () => {
  it("capability_denied makes zero fetches", async () => {
    mk();
    call("storage.get", { key: "k" });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(post.mock.calls[0]?.[0]).toMatchObject({
      type: "result",
      id: "c1",
      ok: false,
      error: { code: "capability_denied" },
    });
  });

  it("params with another artifactId are bad_request with zero fetches", async () => {
    mk();
    call("db.get", { artifactId: "other", collection: "c", id: "d1" });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(post.mock.calls[0]?.[0].error.code).toBe("bad_request");
  });

  it("db.get hits only this artifact's route and replies ok", async () => {
    mk();
    call("db.get", { collection: "c", id: "d1" });
    await flush();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(R.dataDoc("art1", "c", "d1"));
    expect(post.mock.calls[0]?.[0]).toMatchObject({
      type: "result",
      ok: true,
      value: DOC,
    });
  });

  it("maps ApiClientError to code/message", async () => {
    fetchMock.mockImplementation(async () =>
      json({ error: { code: "rate_limited", message: "slow" } }, 429),
    );
    mk();
    call("db.set", { collection: "c", id: "d1", data: { a: 1 } });
    await flush();
    expect(post.mock.calls[0]?.[0].error).toEqual({
      code: "rate_limited",
      message: "slow",
    });
  });

  it("invalid server response becomes an error reply", async () => {
    fetchMock.mockImplementation(async () => json({ nope: 1 }));
    mk();
    call("db.get", { collection: "c", id: "d1" });
    await flush();
    expect(post.mock.calls[0]?.[0]).toMatchObject({ ok: false });
  });

  it("db.get not_found resolves null", async () => {
    fetchMock.mockImplementation(async () =>
      json({ error: { code: "not_found", message: "x" } }, 404),
    );
    mk();
    call("db.get", { collection: "c", id: "d1" });
    await flush();
    expect(post.mock.calls[0]?.[0]).toMatchObject({ ok: true, value: null });
  });

  it("storage.set sends {value}", async () => {
    fetchMock.mockResolvedValue(json({ key: "k", value: 1, updatedAt: "n" }));
    mk({ ...ART, capabilities: { db: false, viewer: false, storage: true } });
    call("storage.set", { key: "k", value: 1 });
    await flush();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(R.storageKey("art1", "k"));
    expect(init.method).toBe("PUT");
    expect(init.body).toBe('{"value":1}');
    expect(post.mock.calls[0]?.[0]).toMatchObject({ ok: true, value: null });
  });
});

describe("pdf / thumb / resize", () => {
  it("routes callbacks", () => {
    const o = {
      iframe,
      artifact: ART,
      version: 1,
      viewer: null,
      theme: "dark" as const,
      onPdfText: vi.fn(),
      onThumb: vi.fn(),
      onResize: vi.fn(),
    };
    createBridge(o);
    send({ oa: 1, type: "pdf.text", version: 1, text: "hi" });
    send({ oa: 1, type: "resize", height: 42 });
    send({
      oa: 1,
      type: "thumb.ready",
      dataUrl: "data:image/webp;base64,AAEC",
    });
    expect(o.onPdfText).toHaveBeenCalledWith("hi");
    expect(o.onResize).toHaveBeenCalledWith(42);
    const blob = o.onThumb.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe("image/webp");
    expect(blob.size).toBe(3);
  });

  it("requestThumbnail and setTheme post to the frame", () => {
    const b = mk();
    b.requestThumbnail();
    b.setTheme("dark");
    expect(post).toHaveBeenCalledWith({ oa: 1, type: "thumb.request" }, "*");
    expect(post).toHaveBeenCalledWith(
      { oa: 1, type: "theme", theme: "dark" },
      "*",
    );
  });
});

describe("db.subscribe", () => {
  const sub = (id: string, collection = "c") =>
    call("db.subscribe", { collection }, id);
  const unsub = (id: string, collection = "c") =>
    call("db.unsubscribe", { collection }, id);

  it("refcounts one socket per collection", async () => {
    mk();
    sub("1");
    sub("2");
    await flush();
    expect(FakeWS.all).toHaveLength(1);
    expect(FakeWS.all[0]?.url).toBe(
      `wss://app.test${R.dataSubscribe("art1", "c")}`,
    );
    unsub("3");
    await flush();
    expect(FakeWS.all[0]?.closed).toBe(false);
    unsub("4");
    await flush();
    expect(FakeWS.all[0]?.closed).toBe(true);
  });

  it("forwards change events and drops malformed frames", async () => {
    mk();
    sub("1");
    await flush();
    const ws = FakeWS.all[0];
    post.mockClear();
    ws?.onmessage?.({ data: "not json" });
    ws?.onmessage?.({ data: JSON.stringify({ type: "db.change", docs: 5 }) });
    ws?.onmessage?.({ data: new ArrayBuffer(2) });
    expect(post).not.toHaveBeenCalled();
    ws?.onmessage?.({
      data: JSON.stringify({
        type: "db.change",
        collection: "c",
        docs: [DOC],
        deleted: ["z"],
      }),
    });
    expect(post).toHaveBeenCalledWith(
      {
        oa: 1,
        type: "event",
        event: "db.change",
        collection: "c",
        docs: [DOC],
        deleted: ["z"],
      },
      "*",
    );
  });

  it("reconnects with exponential backoff capped at 30s", async () => {
    vi.useFakeTimers();
    mk();
    sub("1");
    await vi.advanceTimersByTimeAsync(0);
    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (const [i, d] of delays.entries()) {
      expect(FakeWS.all).toHaveLength(i + 1);
      FakeWS.all[i]?.onclose?.();
      await vi.advanceTimersByTimeAsync(d - 1);
      expect(FakeWS.all).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWS.all).toHaveLength(i + 2);
    }
  });

  it("dispose closes sockets and stops reconnecting", async () => {
    vi.useFakeTimers();
    const b = mk();
    sub("1");
    await vi.advanceTimersByTimeAsync(0);
    FakeWS.all[0]?.onclose?.();
    b.dispose();
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeWS.all).toHaveLength(1);
  });

  it("dispose closes live sockets", async () => {
    const b = mk();
    sub("1");
    await flush();
    b.dispose();
    expect(FakeWS.all[0]?.closed).toBe(true);
  });
});
