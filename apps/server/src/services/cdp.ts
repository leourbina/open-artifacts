// A minimal Chrome DevTools Protocol client over the Browser Run binding, for
// server thumbnails (thumbs.ts). It replaces @cloudflare/puppeteer, whose
// per-isolate load and per-message bookkeeping (Network domain, frame trees,
// an Error with a stack per command) cost 35–80 ms of alarm CPU per capture.
// Here a message costs a JSON.parse and a Map lookup. Same endpoints as
// puppeteer's launch(): POST /v1/devtools/browser acquires a session, a
// websocket upgrade to /v1/devtools/browser/{id} connects to it.

const HOST = "https://fake.host";

/** Acquiring or connecting failed; `status` is the HTTP status (Browser Run's 429). */
export class LaunchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type Params = Record<string, unknown>;
type Pending = { resolve: (r: Params) => void; reject: (e: Error) => void };

export type Cdp = {
  /** One command; `session` targets a page (flatten mode). */
  send<T = Params>(
    method: string,
    params?: Params,
    session?: string,
  ): Promise<T>;
  /** Every event `method` (any session). */
  on(method: string, h: (params: Params, session?: string) => void): void;
  /** Closes the browser (ends the session's billing) and the socket. */
  close(): Promise<void>;
};

export async function connectCdp(binding: Fetcher): Promise<Cdp> {
  let ws: WebSocket;
  try {
    const res = await binding.fetch(`${HOST}/v1/devtools/browser`, {
      method: "POST",
    });
    const text = await res.text();
    if (res.status !== 200)
      throw new LaunchError(
        `Unable to create new browser: code: ${res.status}: message: ${text.slice(0, 200)}`,
        res.status,
      );
    const { sessionId } = JSON.parse(text) as { sessionId: string };
    const up = await binding.fetch(
      `${HOST}/v1/devtools/browser/${encodeURIComponent(sessionId)}`,
      { headers: { Upgrade: "websocket" } },
    );
    if (!up.webSocket) {
      // The binding has no release call for an acquired session: Browser
      // Run reclaims it after its idle timeout (60 s). Log it so it shows.
      console.error(
        JSON.stringify({
          evt: "thumbnail_session_orphaned",
          sessionId,
          status: up.status,
        }),
      );
      throw new LaunchError(`Unable to connect: code: ${up.status}`, up.status);
    }
    ws = up.webSocket;
    ws.accept();
  } catch (e) {
    if (e instanceof LaunchError) throw e;
    throw new LaunchError(String((e as Error)?.message ?? e));
  }

  let seq = 0;
  /** Set once the capture can't go on: every pending and later send rejects. */
  let failed: Error | null = null;
  /** The socket itself closed: nothing more can be sent, Browser.close included. */
  let socketClosed = false;
  const pending = new Map<number, Pending>();
  const handlers = new Map<string, (p: Params, s?: string) => void>();
  const fail = (e: Error) => {
    failed ??= e;
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };
  const raw = <T>(method: string, params: Params, session?: string) => {
    const id = ++seq;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (r: Params) => void, reject });
      ws.send(
        JSON.stringify(
          session
            ? { id, method, params, sessionId: session }
            : { id, method, params },
        ),
      );
    });
  };
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    let m: {
      id?: number;
      method?: string;
      params?: Params;
      result?: Params;
      error?: { message?: string };
      sessionId?: string;
    };
    try {
      m = JSON.parse(ev.data);
    } catch {
      fail(new Error("malformed CDP message"));
      return;
    }
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message ?? "CDP error"));
      else p.resolve(m.result ?? {});
    } else if (m.method) handlers.get(m.method)?.(m.params ?? {}, m.sessionId);
  });
  ws.addEventListener("close", () => {
    socketClosed = true;
    fail(new Error("CDP socket closed"));
  });
  ws.addEventListener("error", () => fail(new Error("CDP socket error")));

  const cdp: Cdp = {
    send<T>(method: string, params: Params = {}, session?: string) {
      if (failed) return Promise.reject(failed);
      return raw<T>(method, params, session);
    },
    on(method, h) {
      handlers.set(method, h);
    },
    async close() {
      // Even after a failure (a bad message, a timeout), close the browser
      // while the socket is up: it ends the session's billing.
      if (!socketClosed) {
        const t = {
          id: undefined as ReturnType<typeof setTimeout> | undefined,
        };
        await Promise.race([
          raw("Browser.close", {}).catch(() => {}),
          new Promise((r) => {
            t.id = setTimeout(r, 1_000);
          }),
        ]);
        clearTimeout(t.id);
      }
      fail(new Error("CDP closed"));
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
  };
  return cdp;
}
