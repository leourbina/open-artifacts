import { execFile } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
   * A secret file: its directory 0700, any existing file removed, then the file
   * created exclusively (no symlink followed) with mode 0600.
   */
  writeSecret?: (path: string, data: string) => void;
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
  // POSIX only: Windows is supported through WSL.
  writeSecret: (p, d) => {
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    chmodSync(dirname(p), 0o700);
    rmSync(p, { force: true });
    const fd = openSync(
      p,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, d);
    } finally {
      closeSync(fd);
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
