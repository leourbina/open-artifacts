import { type ArtifactSummary, LIMITS, R } from "@oa/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
const putBody = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../src/api/client", async (orig) => {
  const m = await orig<typeof import("../src/api/client")>();
  return {
    ...m,
    api: {
      ...m.api,
      get: (...a: unknown[]) => getMock(...a),
      putBody: (...a: unknown[]) => putBody(...a),
    },
  };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

type Hook = typeof import("../src/library/useBackgroundThumbnails");
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
let ua = CHROME_UA;
type Fx = typeof import("../src/viewer/useArtifactSideEffects");
let hook: Hook["useBackgroundThumbnails"];
let thumbAsked: Fx["thumbAsked"];

let n = 0;
const art = (o: Partial<ArtifactSummary> = {}) =>
  ({
    id: `bg${++n}`,
    title: `Art ${n}`,
    format: "html",
    visibility: "private",
    currentVersion: 1,
    thumbnailUrl: null,
    access: "owner",
    capabilities: { db: true, viewer: true, storage: true },
    owner: { id: "u1", name: "U", email: "u@x.y" },
    lastAgent: null,
    updatedAt: new Date().toISOString(),
    ...o,
  }) as unknown as ArtifactSummary;

const contentUrl = (id: string) => ({
  url: `https://content.example.com/c/${id}/index.html?sig=x`,
  expiresAt: null,
});
const frames = () =>
  [...document.querySelectorAll("iframe")] as HTMLIFrameElement[];
const contentCalls = () =>
  getMock.mock.calls
    .map((c) => c[0] as string)
    .filter((p) => p.includes("/content-url"));
/** Lets pending promises (the content URL fetch) settle under fake timers. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

let visibility: DocumentVisibilityState = "visible";
let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);
const run = (items: ArtifactSummary[]) =>
  renderHook((p: { items: ArtifactSummary[] }) => hook(p.items), {
    wrapper,
    initialProps: { items },
  });

const HELLO = { oa: 1, type: "hello", protocol: 1, kind: "html" };
/** A message from the frame, as the bridge sees it: source pinned, opaque origin. */
const fromFrame = (f: HTMLIFrameElement, data: unknown) => {
  const ev = new MessageEvent("message", { data, origin: "null" });
  Object.defineProperty(ev, "source", { value: f.contentWindow });
  window.dispatchEvent(ev);
};
const spyFrame = (f: HTMLIFrameElement) => {
  const post = vi.fn();
  Object.defineProperty(f.contentWindow, "postMessage", {
    configurable: true,
    value: post,
  });
  return post;
};
const webp = (bytes: number) => {
  const head = "RIFF\0\0\0\0WEBP";
  return `data:image/webp;base64,${btoa(head + "a".repeat(bytes - head.length))}`;
};

beforeEach(async () => {
  ua = CHROME_UA;
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    get: () => ua,
  });
  localStorage.clear();
  sessionStorage.clear();
  vi.useFakeTimers();
  vi.resetModules();
  ({ useBackgroundThumbnails: hook } = await import(
    "../src/library/useBackgroundThumbnails"
  ));
  ({ thumbAsked } = await import("../src/viewer/useArtifactSideEffects"));
  getMock.mockReset();
  getMock.mockImplementation(async (p: string) =>
    contentUrl(p.split("/")[4] ?? "x"),
  );
  putBody.mockClear();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  qc = new QueryClient();
});
afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "connection");
  Reflect.deleteProperty(navigator, "userAgent");
  document.body.innerHTML = "";
});

describe("background thumbnails", () => {
  it("queues only editor/owner artifacts with no thumbnail", async () => {
    const viewer = art({ access: "viewer" });
    const has = art({ thumbnailUrl: "/api/v1/artifacts/x/thumbnail" });
    const editor = art({ access: "editor" });
    const owner = art({ access: "owner" });
    run([viewer, has, editor, owner]);
    await settle();
    await act(async () => vi.advanceTimersByTime(10_000));
    await settle();
    await act(async () => vi.advanceTimersByTime(10_000));
    await settle();
    expect(contentCalls()).toEqual([
      R.contentUrl(editor.id),
      R.contentUrl(owner.id),
    ]);
  });

  it("skips formats with no snapshot support (markdown, code)", async () => {
    const md = art({ format: "markdown" });
    const pdf = art({ format: "pdf" });
    run([md, pdf]);
    await settle();
    expect(contentCalls()).toEqual([R.contentUrl(pdf.id)]);
  });

  it("runs one hidden, sandboxed iframe at a time", async () => {
    const a = art();
    run([a, art(), art()]);
    await settle();
    const fs = frames();
    expect(fs).toHaveLength(1);
    const f = fs[0];
    expect(f.getAttribute("sandbox")).toBe("allow-scripts");
    expect(f.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(f.getAttribute("allow")).toBe("");
    expect(f.hasAttribute("inert")).toBe(true);
    expect(f.getAttribute("aria-hidden")).toBe("true");
    expect(f.tabIndex).toBe(-1);
    expect(f.src).toBe(contentUrl(a.id).url);
    expect(f.style.position).toBe("fixed");
    expect(f.style.opacity).toBe("0");
    expect(f.style.pointerEvents).toBe("none");
    expect(f.style.zIndex).toBe("-1");
    expect(f.width).toBe("1280");
    expect(f.height).toBe("800");
  });

  it("forces every capability off, even when the artifact declares them", async () => {
    run([art({ capabilities: { db: true, viewer: true, storage: true } })]);
    await settle();
    const [f] = frames();
    const post = spyFrame(f);
    fromFrame(f, HELLO);
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "welcome",
        capabilities: { db: false, viewer: false, storage: false },
        viewer: null,
      }),
      "*",
    );
    expect(post).toHaveBeenCalledWith({ oa: 1, type: "thumb.request" }, "*");
    getMock.mockClear();
    fromFrame(f, {
      oa: 1,
      type: "call",
      id: "c1",
      method: "db.get",
      params: { collection: "c", id: "d" },
    });
    await settle();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "result",
        id: "c1",
        ok: false,
        error: expect.objectContaining({ code: "capability_denied" }),
      }),
      "*",
    );
    expect(getMock).not.toHaveBeenCalled();
  });

  it("uploads a valid thumbnail, invalidates and tears the frame down", async () => {
    const inv = vi.spyOn(qc, "invalidateQueries");
    const a = art();
    const b = art();
    run([a, b]);
    await settle();
    const [f] = frames();
    spyFrame(f);
    fromFrame(f, HELLO);
    fromFrame(f, { oa: 1, type: "thumb.ready", dataUrl: webp(64) });
    await settle();
    expect(putBody).toHaveBeenCalledWith(
      R.thumbnail(a.id),
      expect.any(Blob),
      "image/webp",
    );
    expect(inv).toHaveBeenCalledWith({
      queryKey: ["artifact", a.id],
      exact: true,
    });
    expect(inv).toHaveBeenCalledWith({ queryKey: ["artifacts"] });
    expect(f.isConnected).toBe(false);
    expect(contentCalls()).toEqual([R.contentUrl(a.id), R.contentUrl(b.id)]);
  });

  it("never uploads an oversized blob", async () => {
    run([art()]);
    await settle();
    const [f] = frames();
    spyFrame(f);
    fromFrame(f, HELLO);
    fromFrame(f, {
      oa: 1,
      type: "thumb.ready",
      dataUrl: webp(LIMITS.thumbnailBytes + 1),
    });
    await settle();
    expect(putBody).not.toHaveBeenCalled();
  });

  it("gives up after 10 s, removes the frame and moves on", async () => {
    const a = art();
    const b = art();
    run([a, b]);
    await settle();
    const [f] = frames();
    await act(async () => vi.advanceTimersByTime(9_999));
    expect(f.isConnected).toBe(true);
    await act(async () => vi.advanceTimersByTime(1));
    expect(f.isConnected).toBe(false);
    await settle();
    expect(frames()).toHaveLength(1);
    expect(frames()[0].src).toBe(contentUrl(b.id).url);
    // The disposed bridge no longer answers the old frame.
    const post = spyFrame(f);
    fromFrame(f, HELLO);
    expect(post).not.toHaveBeenCalled();
  });

  it("stops at 12 attempts per session", async () => {
    run(Array.from({ length: 15 }, () => art()));
    for (let i = 0; i < 15; i++) {
      await settle();
      await act(async () => vi.advanceTimersByTime(10_000));
    }
    await settle();
    expect(contentCalls()).toHaveLength(12);
    expect(frames()).toHaveLength(0);
  });

  it("waits while the tab is hidden and resumes when visible", async () => {
    visibility = "hidden";
    const a = art();
    run([a]);
    await settle();
    expect(contentCalls()).toHaveLength(0);
    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(contentCalls()).toEqual([R.contentUrl(a.id)]);
  });

  it("does not start the next attempt while hidden", async () => {
    run([art(), art()]);
    await settle();
    visibility = "hidden";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(10_000);
    });
    await settle();
    expect(contentCalls()).toHaveLength(1);
    expect(frames()).toHaveLength(0);
  });

  it("respects Save-Data", async () => {
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: { saveData: true },
    });
    run([art()]);
    await settle();
    expect(contentCalls()).toHaveLength(0);
  });

  it("skips ids already asked this session and records new attempts", async () => {
    const a = art();
    const b = art();
    thumbAsked.add(a.id);
    run([a, b]);
    await settle();
    expect(contentCalls()).toEqual([R.contentUrl(b.id)]);
    expect(thumbAsked.has(b.id)).toBe(true);
  });

  it("refuses a content URL on the app origin", async () => {
    getMock.mockImplementation(async () => ({
      url: `${location.origin}/evil`,
      expiresAt: null,
    }));
    run([art()]);
    await settle();
    expect(frames()).toHaveLength(0);
  });

  it("cleans up on unmount", async () => {
    const h = run([art(), art()]);
    await settle();
    const [f] = frames();
    h.unmount();
    expect(f.isConnected).toBe(false);
    const post = spyFrame(f);
    fromFrame(f, HELLO);
    expect(post).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(30_000));
    await settle();
    expect(contentCalls()).toHaveLength(1);
    expect(frames()).toHaveLength(0);
  });
});

describe("background thumbnails: hardening", () => {
  const journal = () =>
    JSON.parse(localStorage.getItem("oa.bgthumb.journal") ?? "{}");

  it("does not start while the user is typing, and starts once they stop", async () => {
    document.body.innerHTML = '<input id="search"><button id="b">b</button>';
    const search = document.getElementById("search") as HTMLInputElement;
    search.focus();
    const a = art();
    run([a]);
    await settle();
    expect(contentCalls()).toHaveLength(0);
    await act(async () => {
      (document.getElementById("b") as HTMLButtonElement).focus();
      vi.advanceTimersByTime(0);
    });
    await settle();
    expect(contentCalls()).toEqual([R.contentUrl(a.id)]);
  });

  it("kills the attempt and gives focus back when the hidden frame takes focus", async () => {
    document.body.innerHTML = '<input id="search">';
    const search = document.getElementById("search") as HTMLInputElement;
    const a = art();
    const b = art();
    run([a, b]);
    await settle();
    const [f] = frames();
    // The user starts typing while the frame loads.
    search.focus();
    // What Chromium does when the frame calls input.focus(): the frame becomes
    // the active element and the library window blurs.
    f.focus();
    window.dispatchEvent(new FocusEvent("blur"));
    await act(async () => vi.advanceTimersByTime(0));
    expect(f.isConnected).toBe(false);
    expect(document.activeElement).toBe(search);
    // Failed in the background, but the viewer may still try.
    expect(thumbAsked.has(a.id)).toBe(false);
    // Not retried; nothing else starts while the user types.
    await settle();
    expect(contentCalls()).toEqual([R.contentUrl(a.id)]);
  });

  it("remembers a started attempt across a reload, so a frame that hangs or crashes the tab is not retried", async () => {
    const a = art();
    run([a]);
    await settle();
    expect(contentCalls()).toEqual([R.contentUrl(a.id)]);
    expect(journal()[a.id]).toEqual(expect.any(Number));
    // Reload: module state is gone, only storage survives.
    getMock.mockClear();
    vi.resetModules();
    const { useBackgroundThumbnails } = await import(
      "../src/library/useBackgroundThumbnails"
    );
    renderHook(() => useBackgroundThumbnails([a]), { wrapper });
    await settle();
    expect(contentCalls()).toEqual([]);
  });

  it("forgets a journal entry after 24 h", async () => {
    const a = art();
    localStorage.setItem(
      "oa.bgthumb.journal",
      JSON.stringify({ [a.id]: Date.now() - 24 * 60 * 60 * 1000 - 1 }),
    );
    run([a]);
    await settle();
    expect(contentCalls()).toEqual([R.contentUrl(a.id)]);
  });

  it("clears the journal entry on success", async () => {
    const a = art();
    run([a]);
    await settle();
    const [f] = frames();
    spyFrame(f);
    fromFrame(f, HELLO);
    fromFrame(f, { oa: 1, type: "thumb.ready", dataUrl: webp(64) });
    await settle();
    expect(journal()[a.id]).toBeUndefined();
    expect(thumbAsked.has(a.id)).toBe(true);
  });

  it("a timed-out attempt stays journaled but no longer blocks the viewer", async () => {
    const a = art();
    run([a]);
    await settle();
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(journal()[a.id]).toEqual(expect.any(Number));
    expect(thumbAsked.has(a.id)).toBe(false);
  });

  it("aborts the content URL request when it gives up", async () => {
    let signal: AbortSignal | undefined;
    getMock.mockImplementation((_p: string, _s: unknown, sig: AbortSignal) => {
      signal = sig;
      return new Promise(() => {});
    });
    const h = run([art()]);
    await settle();
    expect(signal?.aborted).toBe(false);
    h.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("keeps the 12-attempt cap across a reload", async () => {
    sessionStorage.setItem("oa.bgthumb.attempts", "12");
    run([art()]);
    await settle();
    expect(contentCalls()).toHaveLength(0);
  });

  it("stops the in-flight attempt when the tab is hidden, without counting it", async () => {
    sessionStorage.setItem("oa.bgthumb.attempts", "11");
    const a = art();
    run([a]);
    await settle();
    expect(frames()).toHaveLength(1);
    visibility = "hidden";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(frames()).toHaveLength(0);
    expect(journal()[a.id]).toBeUndefined();
    expect(sessionStorage.getItem("oa.bgthumb.attempts")).toBe("11");
    // Retried once visible again.
    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(contentCalls()).toEqual([R.contentUrl(a.id), R.contentUrl(a.id)]);
  });

  it("never runs on WebKit", async () => {
    ua = SAFARI_UA;
    run([art()]);
    await settle();
    expect(contentCalls()).toHaveLength(0);
  });
});

describe("isWebKit", () => {
  let isWebKit: Hook["isWebKit"];
  beforeEach(async () => {
    ({ isWebKit } = await import("../src/library/useBackgroundThumbnails"));
  });
  it.each([
    ["Safari on macOS", SAFARI_UA, 0, true],
    [
      "Safari on iPhone",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      5,
      true,
    ],
    [
      "Chrome on iOS",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1",
      5,
      true,
    ],
    ["iPadOS desktop mode", SAFARI_UA, 5, true],
    ["Chrome on macOS", CHROME_UA, 0, false],
    [
      "Chrome on Android",
      "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
      5,
      false,
    ],
    ["Edge", `${CHROME_UA} Edg/140.0.0.0`, 0, false],
    [
      "Firefox",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:140.0) Gecko/20100101 Firefox/140.0",
      0,
      false,
    ],
  ])("%s", (_name, agent, touch, expected) => {
    expect(isWebKit(agent, touch)).toBe(expected);
  });
});

describe("card thumbnail crossfade", () => {
  let ArtifactCard: typeof import("../src/library/ArtifactCard").ArtifactCard;
  beforeEach(async () => {
    vi.useRealTimers();
    HTMLImageElement.prototype.decode ??= () => Promise.resolve();
    ({ ArtifactCard } = await import("../src/library/ArtifactCard"));
  });
  const URL_ = "/api/v1/artifacts/x/thumbnail";

  it("keeps the fallback until the image decodes, then shows it", async () => {
    let resolve!: () => void;
    const decode = vi
      .spyOn(HTMLImageElement.prototype, "decode")
      .mockImplementation(() => new Promise<void>((r) => (resolve = r)));
    const a = art({ thumbnailUrl: URL_ });
    const { container } = render(<ArtifactCard artifact={a} />);
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(URL_);
    expect(img).not.toHaveAttribute("data-ready");
    expect(container.querySelector(".lib-fallback")).toBeInTheDocument();
    fireEvent.load(img);
    expect(decode).toHaveBeenCalled();
    expect(img).not.toHaveAttribute("data-ready");
    await act(async () => resolve());
    expect(img).toHaveAttribute("data-ready");
    decode.mockRestore();
  });

  it("keeps the fallback when decoding fails", async () => {
    const decode = vi
      .spyOn(HTMLImageElement.prototype, "decode")
      .mockRejectedValue(new Error("bad"));
    const { container } = render(
      <ArtifactCard artifact={art({ thumbnailUrl: URL_ })} />,
    );
    const img = container.querySelector("img") as HTMLImageElement;
    fireEvent.load(img);
    await act(async () => {});
    expect(img).not.toHaveAttribute("data-ready");
    expect(container.querySelector(".lib-fallback")).toBeInTheDocument();
    decode.mockRestore();
  });

  it("keeps the fallback when the image fails to load", async () => {
    const decode = vi.spyOn(HTMLImageElement.prototype, "decode");
    const { container } = render(
      <ArtifactCard artifact={art({ thumbnailUrl: URL_ })} />,
    );
    const img = container.querySelector("img") as HTMLImageElement;
    fireEvent.error(img);
    await act(async () => {});
    expect(decode).not.toHaveBeenCalled();
    expect(img).not.toHaveAttribute("data-ready");
    expect(container.querySelector(".lib-fallback")).toBeInTheDocument();
    decode.mockRestore();
  });

  it("renders only the fallback with no thumbnail", () => {
    const { container } = render(<ArtifactCard artifact={art()} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".lib-fallback")).toBeInTheDocument();
  });
});
