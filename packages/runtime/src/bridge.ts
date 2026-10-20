import type {
  ArtifactToShell,
  ErrorCode,
  Format,
  RuntimeMethod,
  RuntimeParams,
  RuntimeResult,
  ShellToArtifact,
} from "@oa/shared";

export const CALL_TIMEOUT_MS = 15_000;
/** With a parent but no shell message this long after load: no shell. */
export const HANDSHAKE_MS = 3_000;
export const RAW_VIEW_MESSAGE =
  "Open this artifact in Open Artifacts to use live data";

/** API error codes, plus `no_shell`: no viewer shell to reach the server. */
export type RuntimeErrorCode = ErrorCode | "no_shell";

/** Rejection value of every runtime call: `{ code, message }` (an Error). */
export class RuntimeError extends Error {
  constructor(
    public code: RuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

/** The lazily loaded validators (src/schemas.ts). */
export type Schemas = typeof import("./schemas.js");

type Pending = {
  method: RuntimeMethod;
  resolve: (v: unknown) => void;
  reject: (e: RuntimeError) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type Listener = (m: ShellToArtifact) => void;

export interface Bridge {
  /** True in the raw view (no parent shell): every call rejects. */
  readonly raw: boolean;
  /** Runs once when there is no shell (at once in the raw view). */
  onNoShell(cb: () => void): void;
  call<M extends RuntimeMethod>(
    method: M,
    params: RuntimeParams<M>,
  ): Promise<RuntimeResult<M>>;
  /** Shell messages other than `result` (welcome, event, theme, thumb.request). */
  on(l: Listener): () => void;
  /** Posts to the shell once the contract chunk is loaded (no-op in raw view). */
  send(msg: ArtifactToShell): void;
  hello(kind: Format): void;
  dispose(): void;
}

let counter = 0;
const newCallId = (): string => {
  try {
    return crypto.randomUUID();
  } catch {
    return `c${++counter}-${Date.now()}`;
  }
};

/**
 * postMessage link to the parent shell. Only messages whose source is
 * `window.parent` and that parse (parseShellMessage) are accepted, in arrival
 * order; params and results are validated with RUNTIME_PARAMS / RUNTIME_RESULTS.
 */
export function createBridge(loadSchemas: () => Promise<Schemas>): Bridge {
  const win = window;
  const raw = win.parent === win;
  /** null until the shell speaks or the handshake bound passes. */
  let shell: boolean | null = raw ? false : null;
  let handshake: ReturnType<typeof setTimeout> | undefined;
  const goneCbs: (() => void)[] = [];
  const noShell = () => new RuntimeError("no_shell", RAW_VIEW_MESSAGE);
  const pending = new Map<string, Pending>();
  const listeners = new Set<Listener>();
  const schemas: Promise<Schemas | null> = raw
    ? Promise.resolve(null)
    : loadSchemas().catch((e) => {
        console.error("openArtifacts: runtime failed to load", e);
        return null;
      });
  let inbox: Promise<unknown> = schemas;
  const gone = () => {
    if (shell !== null) return;
    shell = false;
    for (const [id, p] of pending) {
      pending.delete(id);
      clearTimeout(p.timer);
      p.reject(noShell());
    }
    for (const cb of goneCbs.splice(0)) cb();
  };
  void schemas.then((s) => {
    if (s && shell === null) handshake = setTimeout(gone, HANDSHAKE_MS);
  });

  const settle = (id: string): Pending | undefined => {
    const p = pending.get(id);
    if (p) {
      pending.delete(id);
      clearTimeout(p.timer);
    }
    return p;
  };

  const handle = (s: Schemas | null, data: unknown) => {
    const m = s?.parseShellMessage(data);
    if (!s || !m) return;
    if (shell === false) return;
    shell = true;
    clearTimeout(handshake);
    if (m.type !== "result") {
      for (const l of [...listeners]) {
        try {
          l(m);
        } catch (err) {
          console.error(err);
        }
      }
      return;
    }
    const p = settle(m.id);
    if (!p) return;
    if (!m.ok) return p.reject(new RuntimeError(m.error.code, m.error.message));
    const r = s.RUNTIME_RESULTS[p.method].safeParse(m.value);
    if (r.success) p.resolve(r.data);
    else p.reject(new RuntimeError("internal", "invalid response from shell"));
  };

  const onMessage = (e: MessageEvent) => {
    if (raw || e.source !== win.parent) return;
    const data: unknown = e.data;
    inbox = inbox.then(() => schemas).then((s) => handle(s, data));
  };
  win.addEventListener("message", onMessage);

  const post = (s: Schemas, msg: ArtifactToShell) => s.sendToShell(msg);
  const send = (msg: ArtifactToShell) => {
    void schemas.then((s) => s && post(s, msg));
  };

  return {
    raw,
    onNoShell(cb) {
      if (shell === false) cb();
      else goneCbs.push(cb);
    },
    call(method, params) {
      if (shell === false) return Promise.reject(noShell());
      const id = newCallId();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new RuntimeError("internal", "shell did not respond"));
        }, CALL_TIMEOUT_MS);
        pending.set(id, {
          method,
          resolve: resolve as (v: unknown) => void,
          reject,
          timer,
        });
        const fail = (code: ErrorCode, message: string) =>
          settle(id)?.reject(new RuntimeError(code, message));
        void schemas.then((s) => {
          if (!pending.has(id)) return;
          if (!s) return fail("internal", "runtime failed to load");
          const parsed = s.RUNTIME_PARAMS[method].safeParse(params);
          if (!parsed.success)
            return fail("bad_request", `invalid params for ${method}`);
          try {
            post(s, { oa: 1, type: "call", id, method, params: parsed.data });
          } catch {
            // DataCloneError: params that postMessage cannot copy.
            fail("bad_request", "params are not cloneable");
          }
        });
      });
    },
    on(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    send,
    hello(kind) {
      void schemas.then(
        (s) =>
          s &&
          post(s, { oa: 1, type: "hello", protocol: s.PROTOCOL_VERSION, kind }),
      );
    },
    dispose() {
      win.removeEventListener("message", onMessage);
      clearTimeout(handshake);
      goneCbs.length = 0;
      for (const p of pending.values()) clearTimeout(p.timer);
      pending.clear();
      listeners.clear();
    },
  };
}
