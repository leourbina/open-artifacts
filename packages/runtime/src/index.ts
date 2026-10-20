import type {
  DataDoc,
  DataQueryInput,
  Format,
  Page,
  ShellToArtifact,
} from "@oa/shared";
import {
  type Bridge,
  createBridge,
  RuntimeError,
  type Schemas,
} from "./bridge.js";

export { RuntimeError, type RuntimeErrorCode } from "./bridge.js";

export type Theme = "light" | "dark";
/**
 * A signed-in viewer, or `{ anonId }` for an anonymous viewer of an artifact
 * that allows anonymous writes (the same short id as their docs' updatedBy
 * "anon:<anonId>"; per browser, resettable, not an account).
 */
export type Viewer =
  | { email: string; name: string | null }
  | { anonId: string };
/**
 * A subscribe() delivery. `resync: true` (with empty docs/deleted) means the
 * live connection was re-established and changes may have been missed:
 * refetch your data when resync is true.
 */
export type ChangeEvent = {
  docs: DataDoc[];
  deleted: string[];
  resync?: true;
};

export interface Collection {
  get(id: string): Promise<DataDoc | null>;
  list(opts?: { cursor?: string; limit?: number }): Promise<Page<DataDoc>>;
  query(q: DataQueryInput): Promise<Page<DataDoc>>;
  set(id: string, data: unknown): Promise<DataDoc>;
  update(id: string, patch: Record<string, unknown>): Promise<DataDoc>;
  delete(id: string): Promise<void>;
  /** Live changes; refetch your data when `e.resync` is true (after a reconnect).
   *  `onReady` runs once the shell has acknowledged the subscription, so callers
   *  can wait for live delivery to be armed before depending on it. */
  subscribe(
    cb: (e: ChangeEvent) => void,
    opts?: { onReady?: () => void },
  ): () => void;
}

export interface OpenArtifacts {
  /** Resolves on the shell's `welcome` (at once in the raw view). */
  ready: Promise<void>;
  viewer: { get(): Promise<Viewer | null> };
  db: { collection(name: string): Collection };
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, v: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    /** The viewer's keys, up to the first STORAGE_LIST_MAX. */
    list(): Promise<string[]>;
  };
  theme: Theme;
  onTheme(cb: (t: Theme) => void): () => void;
}

declare global {
  interface Window {
    openArtifacts?: OpenArtifacts;
  }
}

/** Lazy chunk URLs (relative to the runtime script), set at build time. */
declare const __OA_SNAPSHOT__: string | undefined;
declare const __OA_SCHEMAS__: string | undefined;

export const STORAGE_LIST_MAX = 1000;
const STORAGE_PAGE = 500;
/** storage.list() never follows more than this many pages. */
const STORAGE_LIST_PAGES = 20;

type SnapshotModule = { snapshot(): Promise<string | null> };
export type RuntimeOptions = {
  /** Loads the contract validators (default: the built schemas chunk). */
  loadSchemas?: () => Promise<Schemas>;
  /** Loads the snapshot chunk (default: the built snapshot chunk). */
  loadSnapshot?: () => Promise<SnapshotModule>;
  /** Aborting detaches the runtime from the window (tests). */
  signal?: AbortSignal;
};

const scriptSrc =
  typeof document !== "undefined" &&
  document.currentScript instanceof HTMLScriptElement
    ? document.currentScript.src
    : "";

function lazy<T>(file: string | undefined): () => Promise<T> {
  return () => {
    if (typeof file !== "string")
      return Promise.reject(new Error("chunk not built"));
    const url = new URL(file, scriptSrc || location.href).href;
    return import(/* @vite-ignore */ url) as Promise<T>;
  };
}
const SNAPSHOT =
  typeof __OA_SNAPSHOT__ === "string" ? __OA_SNAPSHOT__ : undefined;
const SCHEMAS = typeof __OA_SCHEMAS__ === "string" ? __OA_SCHEMAS__ : undefined;

/** The page's format: renderer pages carry `<meta name="oa-format">`; else html. */
function pageKind(): Format {
  const v = document
    .querySelector('meta[name="oa-format"]')
    ?.getAttribute("content");
  return v === "markdown" || v === "code" || v === "pdf" ? v : "html";
}

function systemTheme(): Theme {
  try {
    return matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

const ignore = (e: unknown) => {
  if (
    !(
      e instanceof RuntimeError &&
      (e.code === "capability_denied" || e.code === "no_shell")
    )
  )
    console.error("openArtifacts:", e);
};

/** Builds the SDK over a fresh bridge and announces it with `hello` (html pages). */
export function createRuntime(opts: RuntimeOptions = {}): OpenArtifacts {
  const bridge: Bridge = createBridge(
    opts.loadSchemas ?? lazy<Schemas>(SCHEMAS),
  );
  const kind = pageKind();
  const themeCbs = new Set<(t: Theme) => void>();
  const subs = new Map<string, Set<(e: ChangeEvent) => void>>();
  /** One subscription ack per collection; every subscriber chains on it. */
  const ackReady = new Map<string, Promise<unknown>>();
  const queues = new Map<string, Promise<void>>();
  let welcomed: () => void = () => {};
  const ready = new Promise<void>((r) => {
    welcomed = r;
  });

  const setTheme = (t: Theme) => {
    if (api.theme === t) return;
    api.theme = t;
    for (const cb of [...themeCbs]) {
      try {
        cb(t);
      } catch (e) {
        console.error(e);
      }
    }
  };

  /** Docs broadcast with data:null (over 16 KB) are refetched before delivery. */
  async function deliver(
    m: Extract<ShellToArtifact, { event: "db.change" }>,
  ): Promise<void> {
    const deleted = [...m.deleted];
    const docs: DataDoc[] = [];
    for (const d of m.docs) {
      if (d.data !== null) {
        docs.push(d);
        continue;
      }
      const fresh = await bridge
        .call("db.get", { collection: m.collection, id: d.id })
        .catch(() => d);
      if (fresh) docs.push(fresh);
      else deleted.push(d.id);
    }
    emit(m.collection, { docs, deleted });
  }

  function emit(collection: string, e: ChangeEvent): void {
    for (const cb of [...(subs.get(collection) ?? [])]) {
      try {
        cb(e);
      } catch (err) {
        console.error(err);
      }
    }
  }

  const snapshot = async () => {
    try {
      const mod = await (opts.loadSnapshot ?? lazy<SnapshotModule>(SNAPSHOT))();
      const dataUrl = await mod.snapshot();
      if (dataUrl) bridge.send({ oa: 1, type: "thumb.ready", dataUrl });
    } catch {
      // Optional: no thumbnail.
    }
  };

  bridge.on((m) => {
    if (m.type === "welcome") {
      setTheme(m.theme);
      welcomed();
    } else if (m.type === "theme") setTheme(m.theme);
    else if (m.type === "thumb.request") {
      if (kind === "html") void snapshot();
    } else if (m.type === "event") {
      if (!subs.has(m.collection)) return;
      const prev = queues.get(m.collection) ?? Promise.resolve();
      // Queued behind pending deliveries so a resync is never overtaken by older changes.
      const next =
        m.event === "db.resync"
          ? () => emit(m.collection, { docs: [], deleted: [], resync: true })
          : () => deliver(m);
      queues.set(m.collection, prev.then(next).catch(ignore));
    }
  });

  const collection = (name: string): Collection => ({
    get: (id) => bridge.call("db.get", { collection: name, id }),
    list: (o = {}) => bridge.call("db.list", { collection: name, ...o }),
    query: (query) => bridge.call("db.query", { collection: name, query }),
    set: (id, data) => bridge.call("db.set", { collection: name, id, data }),
    update: (id, patch) =>
      bridge.call("db.update", { collection: name, id, patch }),
    delete: async (id) => {
      await bridge.call("db.delete", { collection: name, id });
    },
    subscribe(cb, opts) {
      let set = subs.get(name);
      if (!set) {
        set = new Set();
        subs.set(name, set);
        const mine = set;
        // One ack per collection: every caller chains on the same promise, so a
        // later subscriber's onReady can never fire before the subscription.
        const ack = bridge.call("db.subscribe", { collection: name });
        ackReady.set(name, ack);
        void ack.catch((e) => {
          // Drop the entries so the next subscribe() retries.
          if (subs.get(name) === mine) subs.delete(name);
          if (ackReady.get(name) === ack) ackReady.delete(name);
          ignore(e);
        });
      }
      set.add(cb);
      const own = set;
      let live = true;
      void ackReady.get(name)?.then(
        () => {
          if (!live) return;
          // A throwing onReady is the caller's bug: it must not reach the
          // subscribe-failure path (which would drop every live subscriber).
          try {
            opts?.onReady?.();
          } catch (e) {
            ignore(e);
          }
        },
        // The ack failed; the catch above drops the entry for a retry.
        () => {},
      );
      return () => {
        live = false;
        if (!own.delete(cb) || own.size > 0 || subs.get(name) !== own) return;
        subs.delete(name);
        ackReady.delete(name);
        bridge.call("db.unsubscribe", { collection: name }).catch(ignore);
      };
    },
  });

  const api: OpenArtifacts = {
    ready,
    viewer: { get: () => bridge.call("viewer.get", {}) },
    db: { collection },
    storage: {
      get: (key) => bridge.call("storage.get", { key }),
      set: async (key, value) => {
        await bridge.call("storage.set", { key, value });
      },
      delete: async (key) => {
        await bridge.call("storage.delete", { key });
      },
      async list() {
        const keys: string[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined;
        for (let pages = 0; pages < STORAGE_LIST_PAGES; pages++) {
          const page = await bridge.call("storage.list", {
            limit: STORAGE_PAGE,
            ...(cursor === undefined ? {} : { cursor }),
          });
          for (const k of page.items) keys.push(k.key);
          // Stop on the last page, an empty page, a repeated cursor, or enough keys.
          const next = page.nextCursor;
          if (
            next === null ||
            page.items.length === 0 ||
            seen.has(next) ||
            keys.length >= STORAGE_LIST_MAX
          )
            break;
          seen.add(next);
          cursor = next;
        }
        return keys.slice(0, STORAGE_LIST_MAX);
      },
    },
    theme: systemTheme(),
    onTheme(cb) {
      themeCbs.add(cb);
      return () => {
        themeCbs.delete(cb);
      };
    },
  };

  opts.signal?.addEventListener("abort", () => bridge.dispose());
  if (bridge.raw) welcomed();
  // Renderer pages (markdown/code/pdf) send their own hello.
  else if (kind === "html") bridge.hello(kind);
  return api;
}

if (typeof window !== "undefined" && !window.openArtifacts)
  window.openArtifacts = createRuntime();
