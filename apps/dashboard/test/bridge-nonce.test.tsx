// Every src the shell gives an artifact frame carries a fresh nonce, and the
// bridge built for it is told the same one. The dispose-on-second-load rule
// then only ever sees navigations the frame made itself.
import { diffPath, viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installHarness, mount } from "./harness";

type Opts = { nonce: string };
const createBridge = vi.fn((_: Opts) => ({
  dispose: vi.fn(),
  requestThumbnail: vi.fn(),
  setTheme: vi.fn(),
}));
vi.mock("../src/viewer/bridge", () => ({
  createBridge: (o: Opts) => createBridge(o),
}));

installHarness();
beforeEach(() => createBridge.mockClear());
afterEach(() => vi.useRealTimers());

const ID = (
  fixtures.artifacts.find((a) => a.title === "Landing page") as { id: string }
).id;
const NONCE = /#oa=([A-Za-z0-9_-]{22})$/;
const nonceOf = (src: string | null) => src?.match(NONCE)?.[1];
const frame = () =>
  waitFor(() => {
    const f = document.querySelector("iframe");
    if (!f) throw new Error("no iframe");
    return f;
  });
const lastBridgeNonce = () => createBridge.mock.calls.at(-1)?.[0].nonce;

describe("viewer frame nonce", () => {
  it("src carries a 22-character base64url nonce and the bridge gets the same", async () => {
    mount(viewerPath(ID));
    const f = await frame();
    const n = nonceOf(f.getAttribute("src"));
    expect(n).toBeTruthy();
    await waitFor(() => expect(lastBridgeNonce()).toBe(n));
  });

  it("Reload mints a new nonce, a new src and a new bridge", async () => {
    mount(viewerPath(ID));
    const f = await frame();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = nonceOf(f.getAttribute("src"));
    fireEvent.load(f);
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    const again = document.querySelector("iframe") as HTMLIFrameElement;
    expect(again).not.toBe(f);
    const second = nonceOf(again.getAttribute("src"));
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(lastBridgeNonce()).toBe(second);
    // And once more: never the same nonce twice.
    fireEvent.load(again);
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    const third = nonceOf(
      (document.querySelector("iframe") as HTMLIFrameElement).getAttribute(
        "src",
      ),
    );
    expect(new Set([first, second, third]).size).toBe(3);
  });

  it("switching version mints a new nonce", async () => {
    const router = mount(viewerPath(ID, 2));
    const f = await frame();
    const first = nonceOf(f.getAttribute("src"));
    await act(() => router.navigate({ to: viewerPath(ID, 1) as never }));
    await waitFor(() => {
      const n = nonceOf(
        document.querySelector("iframe")?.getAttribute("src") ?? null,
      );
      expect(n).toBeTruthy();
      expect(n).not.toBe(first);
    });
    await waitFor(() =>
      expect(lastBridgeNonce()).toBe(
        nonceOf(document.querySelector("iframe")?.getAttribute("src") ?? null),
      ),
    );
  });
});

describe("diff preview frame nonce", () => {
  it("each preview iframe has its own nonce", async () => {
    mount(diffPath(ID, 1, 2));
    fireEvent.mouseDown(await screen.findByRole("tab", { name: "Preview" }), {
      button: 0,
    });
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    await waitFor(() =>
      expect(document.querySelectorAll("iframe").length).toBe(2),
    );
    const ns = [...document.querySelectorAll("iframe")].map((f) =>
      nonceOf(f.getAttribute("src")),
    );
    expect(ns.every(Boolean)).toBe(true);
    expect(new Set(ns).size).toBe(2);
  });
});
