import type { ArtifactToShell, DataDoc } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CALL_TIMEOUT_MS, RAW_VIEW_MESSAGE } from "../src/bridge.js";
import { createRuntime, type OpenArtifacts } from "../src/index.js";
import * as schemas from "../src/schemas.js";

type Call = Extract<ArtifactToShell, { type: "call" }>;

const doc = (id: string, data: unknown): DataDoc => ({
  id,
  data,
  updatedAt: "2026-01-01T00:00:00.000Z",
  updatedBy: "u:1",
});

/** Microtask flush (works under fake timers too). */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

let parent: { postMessage: ReturnType<typeof vi.fn> };
let ctl: AbortController;
const realParent = window.parent;

const sent = (): ArtifactToShell[] =>
  parent.postMessage.mock.calls.map((c) => c[0] as ArtifactToShell);
const calls = (method?: string): Call[] =>
  sent().filter(
    (m): m is Call =>
      m.type === "call" && (method === undefined || m.method === method),
  );
const fromShell = (data: unknown, source: unknown = parent) =>
  window.dispatchEvent(
    new MessageEvent("message", { data, source: source as Window }),
  );
const reply = (id: string, value: unknown) =>
  fromShell({ oa: 1, type: "result", id, ok: true, value });

function start(opts: Parameters<typeof createRuntime>[0] = {}): OpenArtifacts {
  return createRuntime({
    loadSchemas: async () => schemas,
    signal: ctl.signal,
    ...opts,
  });
}

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
  vi.useRealTimers();
  Object.defineProperty(window, "parent", {
    value: realParent,
    configurable: true,
  });
  document.head.replaceChildren();
});

describe("B13 SDK breaks", () => {
  it("storage.list terminates on a page with no items but a nextCursor", async () => {
    const oa = start();
    let settled = false;
    void oa.storage.list().then(
      () => (settled = true),
      () => (settled = true),
    );
    for (let i = 0; i < 50 && !settled; i++) {
      await flush();
      const c = calls("storage.list").at(-1);
      if (c) reply(c.id, { items: [], nextCursor: "same" });
      await flush();
    }
    expect(calls("storage.list").length).toBeLessThan(5);
    expect(settled).toBe(true);
  });

  it("a failed db.subscribe is retried by the next subscribe()", async () => {
    const oa = start();
    const col = oa.db.collection("c");
    col.subscribe(() => {});
    await flush();
    const first = calls("db.subscribe")[0];
    if (!first) throw new Error("no subscribe");
    fromShell({
      oa: 1,
      type: "result",
      id: first.id,
      ok: false,
      error: { code: "internal", message: "x" },
    });
    await flush();
    col.subscribe(() => {});
    await flush();
    expect(calls("db.subscribe").length).toBe(2);
  });
});
