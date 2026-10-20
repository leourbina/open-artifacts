import {
  type ArtifactEvent,
  ArtifactEventSchema,
  EVENTS_GONE_CLOSE,
  R,
} from "@oa/shared";

/** The server closes near its signed-URL TTL with this: reconnect at once. */
export const EVENTS_TTL_CLOSE = 4408;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

export interface ArtifactEventsOptions {
  id: string;
  /** Embed mode: the socket connects anonymously (`?embed=1`). */
  embed: boolean;
  onEvent: (e: Exclude<ArtifactEvent, { type: "gone" }>) => void;
  /** A `gone` frame, or a 4403 close: re-check access. No reconnect until `resume`. */
  onGone: () => void;
  /** The socket couldn't connect, or dropped: fall back to refetching on focus. */
  onDown: () => void;
}

/**
 * One R.events socket per viewer. Server to client only: this never sends a
 * frame (the server closes with 1008 if it gets one). Reconnects on 4408 at
 * once and on other drops with backoff; each connect's hello carries the
 * current version, so missed versions are caught up.
 */
export function connectArtifactEvents(opts: ArtifactEventsOptions) {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let paused = false;

  const open = () => {
    if (stopped || paused) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const hint = opts.embed ? "?embed=1" : "";
    const sock = new WebSocket(
      `${proto}//${location.host}${R.events(opts.id)}${hint}`,
    );
    ws = sock;
    sock.onmessage = (e) => {
      if (ws !== sock || typeof e.data !== "string") return;
      let raw: unknown;
      try {
        raw = JSON.parse(e.data);
      } catch {
        return;
      }
      const f = ArtifactEventSchema.safeParse(raw);
      if (!f.success) return;
      if (f.data.type === "hello") attempt = 0;
      if (f.data.type === "gone") {
        gone(sock);
        return;
      }
      opts.onEvent(f.data);
    };
    sock.onclose = (e) => {
      if (ws !== sock || stopped) return;
      ws = null;
      if (e?.code === EVENTS_GONE_CLOSE) {
        gone(sock);
        return;
      }
      if (e?.code === EVENTS_TTL_CLOSE) {
        attempt = 0;
        open();
        return;
      }
      opts.onDown();
      const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt++);
      timer = setTimeout(open, delay);
    };
  };

  const gone = (sock: WebSocket) => {
    if (paused) return;
    paused = true;
    if (ws === sock) ws = null;
    sock.close();
    opts.onGone();
  };

  // Next task: a mount that unmounts at once (StrictMode) never connects.
  timer = setTimeout(open, 0);
  return {
    /** Access is still there after a gone: connect again. */
    resume() {
      if (stopped || !paused) return;
      paused = false;
      attempt = 0;
      open();
    },
    close() {
      stopped = true;
      clearTimeout(timer);
      const s = ws;
      ws = null;
      s?.close();
    },
  };
}
