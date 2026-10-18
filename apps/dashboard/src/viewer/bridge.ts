import {
  type ArtifactSummary,
  type ArtifactToShell,
  DataChangeSchema,
  DataDocSchema,
  type ErrorCode,
  LIMITS,
  METHOD_CAPABILITY,
  PageSchema,
  parseArtifactMessage,
  R,
  RUNTIME_PARAMS,
  RUNTIME_RESULTS,
  type RuntimeMethod,
  type ShellToArtifact,
  StorageEntrySchema,
  StorageKeySchema,
  type StorageSetBody,
} from "@oa/shared";
import type { z } from "zod";
import { ApiClientError, api } from "../api/client";

type Viewer = { email: string; name: string | null };
type Theme = "light" | "dark";

export interface BridgeOptions {
  iframe: HTMLIFrameElement;
  artifact: ArtifactSummary;
  version: number;
  /** This version's format; the artifact's own is only the current version's. */
  formatOf?: () => string | undefined;
  viewer: Viewer | null;
  theme: Theme;
  onPdfText: (text: string) => void;
  onThumb: (blob: Blob) => void;
  onResize?: (h: number) => void;
  /** The frame said hello. */
  onHello?: () => void;
  /** A data subscription was closed with 4403: access was revoked. */
  onAccessLost?: () => void;
}

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const DocPage = PageSchema(DataDocSchema);
const KeyPage = PageSchema(StorageKeySchema);

type Sub = {
  ws: WebSocket | null;
  refs: number;
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
};

const MAX_SUBSCRIPTIONS = 32;
const MAX_IN_FLIGHT = 64;

/** Decodes a webp data URL; null unless it is a RIFF/WEBP image within the size limit. */
function dataUrlToBlob(dataUrl: string): Blob | null {
  let bin: string;
  try {
    bin = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  } catch {
    return null;
  }
  if (
    bin.length > LIMITS.thumbnailBytes ||
    bin.slice(0, 4) !== "RIFF" ||
    bin.slice(8, 12) !== "WEBP"
  )
    return null;
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: "image/webp" });
}

const qs = (p: { cursor?: string; limit?: number }) => {
  const q = new URLSearchParams();
  if (p.cursor !== undefined) q.set("cursor", p.cursor);
  if (p.limit !== undefined) q.set("limit", String(p.limit));
  const s = q.toString();
  return s ? `?${s}` : "";
};

export function createBridge(opts: BridgeOptions) {
  const {
    iframe,
    artifact,
    onPdfText,
    onThumb,
    onResize,
    onHello,
    onAccessLost,
  } = opts;
  const id = artifact.id; // the only artifact id any route is ever built from
  const viewer = artifact.capabilities.viewer ? opts.viewer : null;
  const subs = new Map<string, Sub>();
  let disposed = false;
  let thumbPending = false;
  let lostFired = false;
  let inFlight = 0;
  const abort = new AbortController();

  // The sandboxed frame has an opaque origin, so the only valid targetOrigin is "*".
  // Replies carry no secrets beyond what this frame is already entitled to, and the
  // recipient is pinned to iframe.contentWindow.
  const reply = (msg: ShellToArtifact) => {
    if (disposed) return;
    iframe.contentWindow?.postMessage(msg, "*");
  };
  const ok = (rid: string, value: unknown) =>
    reply({ oa: 1, type: "result", id: rid, ok: true, value });
  const fail = (rid: string, code: ErrorCode, message: string) =>
    reply({
      oa: 1,
      type: "result",
      id: rid,
      ok: false,
      error: { code, message },
    });

  const connect = (col: string, s: Sub) => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${proto}//${location.host}${R.dataSubscribe(id, col)}`,
    );
    s.ws = ws;
    ws.onopen = () => {
      s.attempt = 0;
      lostFired = false;
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      let raw: unknown;
      try {
        raw = JSON.parse(e.data);
      } catch {
        return;
      }
      const ch = DataChangeSchema.safeParse(raw);
      if (!ch.success || ch.data.collection !== col) return;
      reply({
        oa: 1,
        type: "event",
        event: "db.change",
        collection: col,
        docs: ch.data.docs,
        deleted: ch.data.deleted,
      });
    };
    ws.onclose = (e) => {
      if (disposed || s.ws !== ws || s.refs <= 0) return;
      s.ws = null;
      // 4403 hits every socket on any access change; tell the shell once, then retry as usual.
      if (e?.code === 4403 && !lostFired) {
        lostFired = true;
        onAccessLost?.();
      }
      const delay = Math.min(
        BACKOFF_CAP_MS,
        BACKOFF_BASE_MS * 2 ** s.attempt++,
      );
      s.timer = setTimeout(() => {
        if (!disposed && s.refs > 0) connect(col, s);
      }, delay);
    };
  };

  const stop = (s: Sub) => {
    clearTimeout(s.timer);
    const ws = s.ws;
    s.ws = null;
    ws?.close();
  };

  const subscribe = (col: string): boolean => {
    let s = subs.get(col);
    if (!s) {
      if (subs.size >= MAX_SUBSCRIPTIONS) return false;
      s = { ws: null, refs: 0, attempt: 0 };
      subs.set(col, s);
    }
    if (s.refs++ === 0) connect(col, s);
    return true;
  };
  const unsubscribe = (col: string) => {
    const s = subs.get(col);
    if (!s || s.refs === 0) return;
    if (--s.refs === 0) {
      stop(s);
      subs.delete(col);
    }
  };

  const nullIfNotFound = async <T>(p: Promise<T>): Promise<T | null> => {
    try {
      return await p;
    } catch (e) {
      if (e instanceof ApiClientError && e.code === "not_found") return null;
      throw e;
    }
  };

  // Aborted on dispose so in-flight calls stop and never reply.
  const http = {
    get: <T>(path: string, schema: z.ZodType<T>) =>
      api.get(path, schema, abort.signal),
    send: <T = void>(
      method: "POST" | "PUT" | "PATCH" | "DELETE",
      path: string,
      body: unknown,
      schema?: z.ZodType<T>,
    ) => api.send(method, path, body, schema, abort.signal),
  };

  async function run(
    method: RuntimeMethod,
    p: Record<string, any>,
  ): Promise<unknown> {
    switch (method) {
      case "db.get":
        return nullIfNotFound(
          http.get(R.dataDoc(id, p.collection, p.id), DataDocSchema),
        );
      case "db.list":
        return http.get(R.dataCollection(id, p.collection) + qs(p), DocPage);
      case "db.query":
        return http.send(
          "POST",
          R.dataQuery(id, p.collection),
          p.query,
          DocPage,
        );
      case "db.set":
        return http.send(
          "PUT",
          R.dataDoc(id, p.collection, p.id),
          p.data ?? null,
          DataDocSchema,
        );
      case "db.update":
        return http.send(
          "PATCH",
          R.dataDoc(id, p.collection, p.id),
          p.patch,
          DataDocSchema,
        );
      case "db.delete":
        await http.send("DELETE", R.dataDoc(id, p.collection, p.id), undefined);
        return null;
      case "db.subscribe":
        if (!subscribe(p.collection))
          throw new ApiClientError(
            "rate_limited",
            "Too many subscriptions",
            429,
          );
        return null;
      case "db.unsubscribe":
        unsubscribe(p.collection);
        return null;
      case "viewer.get":
        return viewer;
      case "storage.get": {
        const e = await nullIfNotFound(
          http.get(R.storageKey(id, p.key), StorageEntrySchema),
        );
        return e ? e.value : null;
      }
      case "storage.set": {
        const body: StorageSetBody = { value: p.value ?? null };
        await http.send(
          "PUT",
          R.storageKey(id, p.key),
          body,
          StorageEntrySchema,
        );
        return null;
      }
      case "storage.delete":
        await http.send("DELETE", R.storageKey(id, p.key), undefined);
        return null;
      case "storage.list":
        return http.get(R.storage(id) + qs(p), KeyPage);
    }
  }

  async function handleCall(m: Extract<ArtifactToShell, { type: "call" }>) {
    const method = m.method;
    if (inFlight >= MAX_IN_FLIGHT)
      return fail(m.id, "rate_limited", "Too many concurrent calls");
    if (!artifact.capabilities[METHOD_CAPABILITY[method]])
      return fail(
        m.id,
        "capability_denied",
        `Capability not declared for ${method}`,
      );
    const params = RUNTIME_PARAMS[method].safeParse(m.params);
    if (!params.success)
      return fail(m.id, "bad_request", `Invalid params for ${method}`);
    inFlight++;
    try {
      const value = await run(method, params.data as Record<string, any>);
      const checked = RUNTIME_RESULTS[method].safeParse(value);
      if (!checked.success) return fail(m.id, "internal", "Invalid response");
      ok(m.id, checked.data);
    } catch (e) {
      if (e instanceof ApiClientError) fail(m.id, e.code, e.message);
      else fail(m.id, "internal", "Internal error");
    } finally {
      inFlight--;
    }
  }

  const onMessage = (ev: Event) => {
    try {
      handle(ev as MessageEvent);
    } catch {
      // Nothing from the untrusted frame may throw out of the listener.
    }
  };

  const handle = (e: MessageEvent) => {
    if (disposed) return;
    if (e.source !== iframe.contentWindow || e.origin !== "null") return;
    const m = parseArtifactMessage(e.data);
    if (!m) return;
    switch (m.type) {
      case "hello":
        reply({
          oa: 1,
          type: "welcome",
          capabilities: artifact.capabilities,
          viewer,
          theme: opts.theme,
        });
        onHello?.();
        break;
      case "call":
        void handleCall(m);
        break;
      case "pdf.text":
        if (
          (opts.formatOf?.() ??
            (opts.version === artifact.currentVersion
              ? artifact.format
              : undefined)) === "pdf" &&
          m.version === opts.version
        )
          onPdfText(m.text);
        break;
      case "thumb.ready": {
        if (!thumbPending) break;
        thumbPending = false;
        const blob = dataUrlToBlob(m.dataUrl);
        if (blob) onThumb(blob);
        break;
      }
      case "resize":
        if (Number.isFinite(m.height) && m.height >= 0 && m.height <= 100_000)
          onResize?.(m.height);
        break;
    }
  };

  window.addEventListener("message", onMessage);

  return {
    dispose() {
      disposed = true;
      abort.abort();
      window.removeEventListener("message", onMessage);
      for (const s of subs.values()) stop(s);
      subs.clear();
    },
    requestThumbnail(): boolean {
      if (disposed) return false;
      thumbPending = true;
      reply({ oa: 1, type: "thumb.request" });
      return true;
    },
    setTheme(t: Theme) {
      reply({ oa: 1, type: "theme", theme: t });
    },
  };
}
