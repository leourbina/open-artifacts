import {
  type ArtifactSummary,
  type ArtifactToShell,
  DataChangeSchema,
  DataDocSchema,
  type ErrorCode,
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
import { ApiClientError, api } from "../api/client";

type Viewer = { email: string; name: string | null };
type Theme = "light" | "dark";

export interface BridgeOptions {
  iframe: HTMLIFrameElement;
  artifact: ArtifactSummary;
  version: number;
  viewer: Viewer | null;
  theme: Theme;
  onPdfText: (text: string) => void;
  onThumb: (blob: Blob) => void;
  onResize?: (h: number) => void;
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

function dataUrlToBlob(dataUrl: string): Blob {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
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
  const { iframe, artifact, onPdfText, onThumb, onResize } = opts;
  const id = artifact.id; // the only artifact id any route is ever built from
  const viewer = artifact.capabilities.viewer ? opts.viewer : null;
  const subs = new Map<string, Sub>();
  let disposed = false;

  // The sandboxed frame has an opaque origin, so the only valid targetOrigin is "*".
  // Replies carry no secrets beyond what this frame is already entitled to, and the
  // recipient is pinned to iframe.contentWindow.
  const reply = (msg: ShellToArtifact) =>
    iframe.contentWindow?.postMessage(msg, "*");
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
    ws.onclose = () => {
      if (disposed || s.ws !== ws || s.refs <= 0) return;
      s.ws = null;
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

  const subscribe = (col: string) => {
    let s = subs.get(col);
    if (!s) {
      s = { ws: null, refs: 0, attempt: 0 };
      subs.set(col, s);
    }
    if (s.refs++ === 0) connect(col, s);
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

  async function run(
    method: RuntimeMethod,
    p: Record<string, any>,
  ): Promise<unknown> {
    switch (method) {
      case "db.get":
        return nullIfNotFound(
          api.get(R.dataDoc(id, p.collection, p.id), DataDocSchema),
        );
      case "db.list":
        return api.get(R.dataCollection(id, p.collection) + qs(p), DocPage);
      case "db.query":
        return api.send(
          "POST",
          R.dataQuery(id, p.collection),
          p.query,
          DocPage,
        );
      case "db.set":
        return api.send(
          "PUT",
          R.dataDoc(id, p.collection, p.id),
          p.data ?? null,
          DataDocSchema,
        );
      case "db.update":
        return api.send(
          "PATCH",
          R.dataDoc(id, p.collection, p.id),
          p.patch,
          DataDocSchema,
        );
      case "db.delete":
        await api.send("DELETE", R.dataDoc(id, p.collection, p.id), undefined);
        return null;
      case "db.subscribe":
        subscribe(p.collection);
        return null;
      case "db.unsubscribe":
        unsubscribe(p.collection);
        return null;
      case "viewer.get":
        return viewer;
      case "storage.get": {
        const e = await nullIfNotFound(
          api.get(R.storageKey(id, p.key), StorageEntrySchema),
        );
        return e ? e.value : null;
      }
      case "storage.set": {
        const body: StorageSetBody = { value: p.value ?? null };
        await api.send(
          "PUT",
          R.storageKey(id, p.key),
          body,
          StorageEntrySchema,
        );
        return null;
      }
      case "storage.delete":
        await api.send("DELETE", R.storageKey(id, p.key), undefined);
        return null;
      case "storage.list":
        return api.get(R.storage(id) + qs(p), KeyPage);
    }
  }

  async function handleCall(m: Extract<ArtifactToShell, { type: "call" }>) {
    const method = m.method;
    if (!artifact.capabilities[METHOD_CAPABILITY[method]])
      return fail(
        m.id,
        "capability_denied",
        `Capability not declared for ${method}`,
      );
    const params = RUNTIME_PARAMS[method].safeParse(m.params);
    if (!params.success)
      return fail(m.id, "bad_request", `Invalid params for ${method}`);
    try {
      const value = await run(method, params.data as Record<string, any>);
      const checked = RUNTIME_RESULTS[method].safeParse(value);
      if (!checked.success) return fail(m.id, "internal", "Invalid response");
      ok(m.id, checked.data);
    } catch (e) {
      if (e instanceof ApiClientError) fail(m.id, e.code, e.message);
      else fail(m.id, "internal", "Internal error");
    }
  }

  const onMessage = (ev: Event) => {
    const e = ev as MessageEvent;
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
        break;
      case "call":
        void handleCall(m);
        break;
      case "pdf.text":
        onPdfText(m.text);
        break;
      case "thumb.ready":
        onThumb(dataUrlToBlob(m.dataUrl));
        break;
      case "resize":
        onResize?.(m.height);
        break;
    }
  };

  window.addEventListener("message", onMessage);

  return {
    dispose() {
      disposed = true;
      window.removeEventListener("message", onMessage);
      for (const s of subs.values()) stop(s);
      subs.clear();
    },
    requestThumbnail() {
      reply({ oa: 1, type: "thumb.request" });
    },
    setTheme(t: Theme) {
      reply({ oa: 1, type: "theme", theme: t });
    },
  };
}
