import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (
  cmd: string,
  args: string[],
  opts?: { env?: Record<string, string>; input?: string },
) => Promise<ExecResult>;
export type Fs = {
  read: (path: string) => string | null;
  write: (path: string, data: string) => void;
  /**
   * A token file, opened without following symlinks and read from the same
   * descriptor that was checked: null when it does not exist.
   */
  readToken?: (path: string) => TokenFile | null;
  /**
   * A secret file: its directory 0700 (refused if a symlink or not yours), the
   * data written to a 0600 temp file beside it and renamed over it, so a
   * failure keeps the old file.
   */
  writeSecret?: (path: string, data: string) => void;
  /** A hash of every file under `base`/`rels` (names relative to `base`, and contents); undefined when none exists. */
  hashTree?: (base: string, rels: string[]) => string | undefined;
  /** A new empty temp directory. */
  tempDir?: () => string;
  /** Removes a file or directory tree (best effort). */
  removeTree?: (path: string) => void;
};
export type TokenFile = {
  text: string;
  /** Permission bits. */
  mode: number;
  uid: number;
  /** A regular file (a symlink, directory or device is not). */
  isFile: boolean;
};
export type Deps = {
  exec: Exec;
  fetch: typeof fetch;
  /** `secret: true` must not echo what is typed. */
  prompt: (question: string, opts?: { secret?: boolean }) => Promise<string>;
  out: (line: string) => void;
  env: Record<string, string | undefined>;
  fs?: Fs;
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: how long the health checks keep retrying a host that doesn't resolve (default 5 minutes). */
  dnsWaitMs?: number;
  /** Test seam: Date.now (the DNS wait is wall-clock time). */
  now?: () => number;
  /** Test seam: process.platform (picks the DNS cache flush hint). */
  platform?: string;
  /** Test seam: process.exit. */
  exit?: (code: number) => void;
  /** Env for wrangler children beyond the process env: a deploy token read from a file. */
  childEnv?: Record<string, string>;
  /** Test seam: process.on for SIGTERM/SIGINT; returns the unsubscribe. */
  onSignal?: (sig: "SIGTERM" | "SIGINT", h: () => void) => () => void;
};

export const realFs: Fs = {
  read: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  write: (p, d) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, d);
  },
  hashTree: (base, rels) => {
    const h = createHash("sha256");
    let any = false;
    const walk = (rel: string) => {
      const p = join(base, rel);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        return;
      }
      if (st.isDirectory()) {
        for (const n of readdirSync(p).sort())
          if (n !== "node_modules") walk(join(rel, n));
      } else if (st.isFile()) {
        any = true;
        h.update(`${rel}\0`).update(readFileSync(p)).update("\0");
      }
    };
    for (const r of rels) walk(r);
    return any ? h.digest("hex") : undefined;
  },
  tempDir: () => mkdtempSync(join(tmpdir(), "oa-bundle-")),
  removeTree: (p) => rmSync(p, { recursive: true, force: true }),
  // POSIX only: Windows is supported through WSL.
  writeSecret: (p, d) => {
    const dir = dirname(p);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Never trust a symlinked or foreign directory with a token.
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory())
      throw new Error(`${dir} is not a plain directory`);
    if (process.getuid && st.uid !== process.getuid())
      throw new Error(`${dir} is not owned by you`);
    chmodSync(dir, 0o700);
    // Write beside the target, then rename over it: a failure keeps the old file.
    const tmp = join(dir, `.${basename(p)}.${process.pid}.tmp`);
    rmSync(tmp, { force: true });
    const fd = openSync(
      tmp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        writeFileSync(fd, d);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, p);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  },
  readToken: (p) => {
    let fd: number | undefined;
    try {
      fd = openSync(
        p,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const st = fstatSync(fd);
      return {
        text: st.isFile() ? readFileSync(fd, "utf8") : "",
        mode: st.mode & 0o777,
        uid: st.uid,
        isFile: st.isFile(),
      };
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return null;
      // A symlink (ELOOP) or anything unreadable is refused, never followed.
      return { text: "", mode: 0o777, uid: -1, isFile: false };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  },
};

export function realDeps(): Deps {
  return {
    env: process.env,
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    out: (l) => console.log(l),
    prompt: async (q, opts) => {
      let muted = false;
      const output = new Writable({
        write: (chunk, _enc, cb) => {
          if (!muted) process.stderr.write(chunk);
          cb();
        },
      });
      const rl = createInterface({
        input: process.stdin,
        output,
        terminal: true,
      });
      try {
        const answer = rl.question(`${q} `);
        muted = Boolean(opts?.secret);
        return (await answer).trim();
      } finally {
        rl.close();
        if (opts?.secret) process.stderr.write("\n");
      }
    },
    exec: (cmd, args, opts) =>
      new Promise((resolve) => {
        const env = { ...childEnv(process.env), ...opts?.env };
        const child = execFile(cmd, args, { env }, (err, stdout, stderr) =>
          resolve({ code: err ? Number(err.code) || 1 : 0, stdout, stderr }),
        );
        // EPIPE is expected when the child exits without reading stdin; the exit code comes from the callback.
        child.stdin?.on("error", () => {});
        child.stdin?.end(opts?.input ?? "");
      }),
  };
}

/** Parent env minus what children must never see: the Access and analytics tokens, wrangler log knobs. */
export const childEnv = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(
    Object.entries(env).filter(
      ([k]) =>
        k !== "OA_ACCESS_TOKEN" &&
        k !== "ANALYTICS_TOKEN" &&
        !k.startsWith("WRANGLER_LOG"),
    ),
  );

/**
 * Runs the server package's pinned wrangler; throws on a non-zero exit.
 * `sensitive` keeps stdout (which may hold a token or secret) out of errors.
 */
export function makeWrangler(
  deps: Deps,
  root: string,
  accountId: () => string | undefined,
) {
  return async (
    args: string[],
    o: { input?: string; sensitive?: boolean } = {},
  ): Promise<string> => {
    const id = accountId();
    const extra = {
      ...(id ? { CLOUDFLARE_ACCOUNT_ID: id } : {}),
      ...deps.childEnv,
    };
    const env = Object.keys(extra).length ? extra : undefined;
    const pnpmArgs = [
      "--dir",
      join(root, "apps/server"),
      "exec",
      "wrangler",
      ...args,
    ];
    const r = await deps.exec("pnpm", pnpmArgs, { env, input: o.input });
    if (r.code !== 0) {
      const detail = o.sensitive ? r.stderr : r.stderr || r.stdout;
      throw new Error(`wrangler ${args.join(" ")} failed: ${detail.trim()}`);
    }
    return r.stdout;
  };
}
export type Wrangler = ReturnType<typeof makeWrangler>;

const API = "https://api.cloudflare.com/client/v4";

async function wranglerToken(wrangler: Wrangler): Promise<string> {
  const out = await wrangler(["auth", "token", "--json"], { sensitive: true });
  let token: unknown;
  try {
    token = JSON.parse(out).token;
  } catch {}
  if (typeof token !== "string" || !token)
    throw new Error(
      "could not read an API token from `wrangler auth token --json`; run `wrangler login` or set CLOUDFLARE_API_TOKEN",
    );
  return token;
}

type Envelope<T> = {
  success?: boolean;
  result?: T;
  result_info?: { total_pages?: number };
  errors?: { message: string }[];
};

/** Cloudflare v4 client. Token: CLOUDFLARE_API_TOKEN, else `wrangler auth token`. */
export function makeApi(deps: Deps, wrangler: Wrangler, initial?: string) {
  let token = initial || deps.env.CLOUDFLARE_API_TOKEN;
  const call = async <T>(method: string, path: string, body?: unknown) => {
    token ??= await wranglerToken(wrangler);
    const res = await deps.fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Envelope<T>;
    if (!res.ok || !json.success) {
      const msg =
        json.errors?.map((e) => e.message).join("; ") || res.statusText;
      throw Object.assign(
        new Error(`${method} ${path}: ${res.status} ${msg}`),
        { status: res.status },
      );
    }
    return json;
  };
  const api = async <T>(method: string, path: string, body?: unknown) =>
    (await call<T>(method, path, body)).result as T;
  /** GETs a paged list: stops on a short page or at `total_pages`. */
  const all = async <T>(path: string): Promise<T[]> => {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= 1000; page++) {
      const env = await call<T[]>(
        "GET",
        `${path}${sep}per_page=100&page=${page}`,
      );
      const batch = env.result ?? [];
      out.push(...batch);
      const total = env.result_info?.total_pages;
      if (batch.length < 100 || (total !== undefined && page >= total)) break;
    }
    return out;
  };
  return Object.assign(api, { all });
}
export type Api = ReturnType<typeof makeApi>;
