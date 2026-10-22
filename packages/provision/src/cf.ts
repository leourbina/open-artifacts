// Cloudflare REST client for the hosted provisioner. Typed calls only; every
// script call picks its route from the caller's `target` (decision 1), never
// from an install id. Errors carry method, route, status and Cloudflare's own
// error text, never a request body, header or token.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { UploadMetadata } from "./metadata.js";

const API = "https://api.cloudflare.com/client/v4";
const TRIES = 3;

export type Target = { kind: "account" } | { kind: "namespace"; ns: string };

export class CfError extends Error {
  override name = "CfError";
  constructor(
    readonly method: string,
    readonly route: string,
    readonly status: number,
    /** Cloudflare's error codes and messages (never the request body). */
    readonly cfMessage: string,
  ) {
    super(
      `Cloudflare ${method} ${route}: HTTP ${status}${cfMessage ? ` (${cfMessage})` : ""}`,
    );
  }
}

export interface Module {
  name: string;
  type: "esm" | "wasm";
  bytes: Uint8Array;
}

export interface D1Result {
  results?: Record<string, unknown>[];
  success?: boolean;
  meta?: { changes?: number };
}

export interface TokenInfo {
  status?: string;
  not_before?: string;
  expires_on?: string;
}

export interface Cf {
  readonly accountId: string;
  tokenVerify(): Promise<TokenInfo>;
  /** GET /accounts/{id}/workers/scripts?per_page=1 (proves Workers Scripts Read). */
  scriptsRead(): Promise<void>;
  d1Create(name: string): Promise<string>;
  d1Get(name: string): Promise<string | null>;
  d1Query(id: string, sql: string, params?: unknown[]): Promise<D1Result[]>;
  d1Delete(id: string): Promise<void>;
  r2Create(name: string): Promise<void>;
  r2Exists(name: string): Promise<boolean>;
  r2Delete(name: string): Promise<void>;
  kvCreate(title: string): Promise<string>;
  kvFind(title: string): Promise<string | null>;
  kvDelete(id: string): Promise<void>;
  kvPut(id: string, key: string, value: string): Promise<void>;
  kvGet(id: string, key: string): Promise<string | null>;
  kvDeleteKey(id: string, key: string): Promise<void>;
  scriptExists(t: Target, script: string): Promise<boolean>;
  scriptUpload(
    t: Target,
    script: string,
    metadata: UploadMetadata,
    modules: Module[],
  ): Promise<void>;
  scriptDelete(t: Target, script: string): Promise<void>;
  secretPut(
    t: Target,
    script: string,
    name: string,
    text: string,
  ): Promise<void>;
  secretList(t: Target, script: string): Promise<string[]>;
  scriptSubdomain(
    t: Target,
    script: string,
    body: { enabled: boolean; previews_enabled: boolean },
  ): Promise<void>;
  /** Upload session on the target's route, buckets on the account route; returns the completion jwt. */
  assetsUpload(
    t: Target,
    script: string,
    dir: string,
  ): Promise<{ jwt: string }>;
}

/** Manifest hash: the first 32 hex characters of SHA-256 (64 is rejected). */
export function assetHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

const seg = (s: string) => encodeURIComponent(s);

function scriptBase(t: Target, script: string): string {
  if (t.kind === "account") return `/workers/scripts/${seg(script)}`;
  if (t.kind === "namespace" && typeof t.ns === "string" && t.ns !== "")
    return `/workers/dispatch/namespaces/${seg(t.ns)}/scripts/${seg(script)}`;
  throw new Error("invalid script target");
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out.sort();
}

function describeErrors(body: unknown): string {
  const errs = (body as { errors?: { code?: unknown; message?: unknown }[] })
    ?.errors;
  if (!Array.isArray(errs)) return "";
  return errs
    .map((e) => `${e?.code ?? ""} ${String(e?.message ?? "")}`.trim())
    .join("; ")
    .slice(0, 300);
}

type CallInit = { body?: BodyInit; json?: unknown; auth?: string };

export function cfClient(o: {
  accountId: string;
  token: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Cf {
  if (!/^[0-9a-f]{32}$/.test(o.accountId))
    throw new Error("accountId must be 32 hex characters");
  const f = o.fetch ?? fetch;
  const sleep =
    o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const acct = `/accounts/${o.accountId}`;

  /** One call, 3 tries on 429/5xx/network; errors show the route without its query. */
  async function call(
    method: string,
    path: string,
    init: CallInit = {},
    ok: number[] = [],
  ): Promise<{ status: number; body: unknown; text: string }> {
    const route = path.split("?")[0] as string;
    const headers: Record<string, string> = {
      authorization: `Bearer ${init.auth ?? o.token}`,
    };
    let body = init.body;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    let last: CfError | undefined;
    for (let i = 0; i < TRIES; i++) {
      if (i > 0) await sleep(500 * 2 ** (i - 1));
      let res: Response;
      try {
        res = await f(`${API}${path}`, { method, headers, body });
      } catch (e) {
        last = new CfError(method, route, 0, `network: ${(e as Error).name}`);
        continue;
      }
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (res.ok || ok.includes(res.status))
        return { status: res.status, body: parsed, text };
      last = new CfError(method, route, res.status, describeErrors(parsed));
      if (res.status !== 429 && res.status < 500) throw last;
    }
    throw last as CfError;
  }
  const result = async <T>(
    method: string,
    path: string,
    init?: CallInit,
  ): Promise<T> =>
    ((await call(method, path, init)).body as { result: T })?.result;
  const exists = async (path: string) =>
    (await call("GET", path, {}, [404])).status !== 404;
  const kvPath = (id: string, key: string) =>
    `${acct}/storage/kv/namespaces/${seg(id)}/values/${seg(key)}`;

  return {
    accountId: o.accountId,
    tokenVerify: () => result<TokenInfo>("GET", "/user/tokens/verify"),
    async scriptsRead() {
      await call("GET", `${acct}/workers/scripts?per_page=1`);
    },

    async d1Create(name) {
      const r = await result<{ uuid: string }>("POST", `${acct}/d1/database`, {
        json: { name },
      });
      return r.uuid;
    },
    async d1Get(name) {
      const r = await result<{ uuid: string; name: string }[]>(
        "GET",
        `${acct}/d1/database?name=${seg(name)}&per_page=100`,
      );
      return r.find((d) => d.name === name)?.uuid ?? null;
    },
    d1Query: (id, sql, params = []) =>
      result<D1Result[]>("POST", `${acct}/d1/database/${seg(id)}/query`, {
        json: { sql, params },
      }),
    async d1Delete(id) {
      await call("DELETE", `${acct}/d1/database/${seg(id)}`);
    },

    async r2Create(name) {
      await call("POST", `${acct}/r2/buckets`, { json: { name } });
    },
    r2Exists: (name) => exists(`${acct}/r2/buckets/${seg(name)}`),
    async r2Delete(name) {
      await call("DELETE", `${acct}/r2/buckets/${seg(name)}`);
    },

    async kvCreate(title) {
      const r = await result<{ id: string }>(
        "POST",
        `${acct}/storage/kv/namespaces`,
        { json: { title } },
      );
      return r.id;
    },
    async kvFind(title) {
      for (let page = 1; page <= 50; page++) {
        const r = await result<{ id: string; title: string }[]>(
          "GET",
          `${acct}/storage/kv/namespaces?per_page=100&page=${page}`,
        );
        const hit = r.find((n) => n.title === title);
        if (hit) return hit.id;
        if (r.length < 100) return null;
      }
      throw new Error("KV namespace listing did not end after 50 pages");
    },
    async kvDelete(id) {
      await call("DELETE", `${acct}/storage/kv/namespaces/${seg(id)}`);
    },
    async kvPut(id, key, value) {
      await call("PUT", kvPath(id, key), { body: value });
    },
    async kvGet(id, key) {
      const r = await call("GET", kvPath(id, key), {}, [404]);
      return r.status === 404 ? null : r.text;
    },
    async kvDeleteKey(id, key) {
      await call("DELETE", kvPath(id, key));
    },

    scriptExists: (t, script) =>
      exists(`${acct}${scriptBase(t, script)}/settings`),
    async scriptUpload(t, script, metadata, modules) {
      const form = new FormData();
      form.append(
        "metadata",
        new Blob([JSON.stringify(metadata)], { type: "application/json" }),
      );
      for (const m of modules)
        form.append(
          m.name,
          new Blob([m.bytes as BlobPart], {
            type:
              m.type === "wasm"
                ? "application/wasm"
                : "application/javascript+module",
          }),
          m.name,
        );
      await call("PUT", `${acct}${scriptBase(t, script)}`, { body: form });
    },
    async scriptDelete(t, script) {
      await call("DELETE", `${acct}${scriptBase(t, script)}`);
    },
    async secretPut(t, script, name, text) {
      await call("PUT", `${acct}${scriptBase(t, script)}/secrets`, {
        json: { name, text, type: "secret_text" },
      });
    },
    async secretList(t, script) {
      const r = await result<{ name: string }[]>(
        "GET",
        `${acct}${scriptBase(t, script)}/secrets`,
      );
      return r.map((s) => s.name);
    },
    async scriptSubdomain(t, script, body) {
      await call("POST", `${acct}${scriptBase(t, script)}/subdomain`, {
        json: body,
      });
    },
    async assetsUpload(t, script, dir) {
      const files = new Map<string, Uint8Array>();
      const manifest: Record<string, { hash: string; size: number }> = {};
      for (const p of await walk(dir)) {
        const bytes = new Uint8Array(await readFile(p));
        const hash = assetHash(bytes);
        manifest[`/${relative(dir, p).split(sep).join("/")}`] = {
          hash,
          size: bytes.byteLength,
        };
        files.set(hash, bytes);
      }
      const sess = await result<{ jwt: string; buckets?: string[][] }>(
        "POST",
        `${acct}${scriptBase(t, script)}/assets-upload-session`,
        { json: { manifest } },
      );
      const buckets = sess.buckets ?? [];
      // Nothing new to upload: the session jwt is the completion token.
      if (buckets.length === 0) return { jwt: sess.jwt };
      let jwt = sess.jwt;
      const route = `${acct}/workers/assets/upload`;
      for (const [i, bucket] of buckets.entries()) {
        const form = new FormData();
        for (const h of bucket) {
          const bytes = files.get(h);
          if (!bytes)
            throw new Error("assets session asked for an unknown file");
          form.append(h, Buffer.from(bytes).toString("base64"));
        }
        // Always the account route, even for a namespace script.
        const r = await call(
          "POST",
          `${route}?base64=true`,
          { body: form, auth: jwt },
          [201, 202],
        );
        const next = (r.body as { result?: { jwt?: string } })?.result?.jwt;
        const last = i === buckets.length - 1;
        if (last && (r.status !== 201 || !next))
          throw new CfError(
            "POST",
            route,
            r.status,
            "no completion token on the last bucket",
          );
        if (next) jwt = next;
      }
      return { jwt };
    },
  };
}
