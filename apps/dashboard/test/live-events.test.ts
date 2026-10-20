// Live versions: the R.events client (one socket, never sends, reconnects)
// and Design's safe-swap decision table (option B).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectArtifactEvents } from "../src/viewer/liveEvents";
import { isSafeSwap } from "../src/viewer/useLiveVersions";

class FakeWS {
  static all: FakeWS[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  frame(f: unknown) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
  closed(code: number) {
    this.onclose?.({ code });
  }
}
const last = () => FakeWS.all[FakeWS.all.length - 1] as FakeWS;

const mk = (embed = false) => {
  const onEvent = vi.fn();
  const onGone = vi.fn();
  const onDown = vi.fn();
  const c = connectArtifactEvents({
    id: "abc",
    embed,
    onEvent,
    onGone,
    onDown,
  });
  vi.advanceTimersByTime(0);
  return { c, onEvent, onGone, onDown };
};

beforeEach(() => {
  FakeWS.all = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWS);
  vi.stubGlobal("location", { protocol: "https:", host: "app.test" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("events socket", () => {
  it("opens one socket on R.events; embed adds ?embed=1", () => {
    mk().c.close();
    mk(true).c.close();
    expect(FakeWS.all.map((w) => w.url)).toEqual([
      "wss://app.test/api/v1/artifacts/abc/events",
      "wss://app.test/api/v1/artifacts/abc/events?embed=1",
    ]);
  });

  it("passes hello and version frames; drops anything else", () => {
    const { onEvent } = mk();
    last().frame({ type: "hello", version: 3 });
    last().frame({
      type: "version",
      version: 4,
      at: "2026-10-20T00:00:00Z",
      by: { kind: "agent", name: "Bot" },
      restoredFrom: 1,
    });
    last().frame({ type: "hello" });
    last().onmessage?.({ data: "not json" });
    last().frame({ type: "nope", version: 9 });
    expect(onEvent.mock.calls.map(([e]) => e.type)).toEqual([
      "hello",
      "version",
    ]);
    expect(onEvent.mock.calls[1]?.[0].restoredFrom).toBe(1);
  });

  it("never sends anything on the socket", () => {
    const { c } = mk();
    last().frame({ type: "hello", version: 1 });
    last().closed(4408);
    last().frame({ type: "hello", version: 1 });
    last().closed(1006);
    vi.advanceTimersByTime(60_000);
    c.close();
    for (const w of FakeWS.all) expect(w.send).not.toHaveBeenCalled();
  });

  it("reconnects at once on 4408; the new hello catches up", () => {
    const { onEvent, onDown } = mk();
    last().frame({ type: "hello", version: 2 });
    last().closed(4408);
    expect(FakeWS.all).toHaveLength(2);
    expect(onDown).not.toHaveBeenCalled();
    last().frame({ type: "hello", version: 5 });
    expect(onEvent).toHaveBeenLastCalledWith({ type: "hello", version: 5 });
  });

  it("reconnects on drops with backoff, and reports it down", () => {
    const { onDown } = mk();
    last().closed(1006);
    expect(onDown).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(999);
    expect(FakeWS.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWS.all).toHaveLength(2);
    last().closed(1006);
    vi.advanceTimersByTime(1_999);
    expect(FakeWS.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWS.all).toHaveLength(3);
    // A hello resets the backoff.
    last().frame({ type: "hello", version: 1 });
    last().closed(1006);
    vi.advanceTimersByTime(1_000);
    expect(FakeWS.all).toHaveLength(4);
  });

  it("gone: reports once, closes, and waits for resume", () => {
    const { c, onGone, onEvent } = mk();
    const w = last();
    w.frame({ type: "gone" });
    w.closed(4403);
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(w.close).toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.all).toHaveLength(1);
    c.resume();
    expect(FakeWS.all).toHaveLength(2);
  });

  it("a bare 4403 close is gone too", () => {
    const { onGone } = mk();
    last().closed(4403);
    expect(onGone).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.all).toHaveLength(1);
  });

  it("close stops for good", () => {
    const { c } = mk();
    const w = last();
    c.close();
    expect(w.close).toHaveBeenCalled();
    w.closed(1006);
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.all).toHaveLength(1);
  });
});

describe("safe swap (Design's Spec for B)", () => {
  const all = {
    following: true,
    hello: true,
    touched: false,
    chromeOpen: false,
  };
  it.each([
    [{}, true],
    [{ following: false }, false],
    [{ hello: false }, false],
    [{ touched: true }, false],
    [{ chromeOpen: true }, false],
    [{ hello: false, touched: true }, false],
    [{ following: false, chromeOpen: true }, false],
  ])("%o → swap %s", (patch, swap) => {
    expect(isSafeSwap({ ...all, ...patch })).toBe(swap);
  });
});
