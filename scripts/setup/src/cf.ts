import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (
  cmd: string,
  args: string[],
  opts?: { env?: Record<string, string>; input?: string },
) => Promise<ExecResult>;
export type Fs = {
  read: (path: string) => string | null;
  write: (path: string, data: string) => void;
};
export type Deps = {
  exec: Exec;
  fetch: typeof fetch;
  prompt: (question: string) => Promise<string>;
  out: (line: string) => void;
  env: Record<string, string | undefined>;
  fs?: Fs;
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
};

export function realDeps(): Deps {
  return {
    env: process.env,
    fetch: globalThis.fetch,
    out: (l) => console.log(l),
    prompt: async (q) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        return (await rl.question(`${q} `)).trim();
      } finally {
        rl.close();
      }
    },
    exec: (cmd, args, opts) =>
      new Promise((resolve) => {
        const env = { ...process.env, ...opts?.env };
        const child = execFile(cmd, args, { env }, (err, stdout, stderr) =>
          resolve({ code: err ? Number(err.code) || 1 : 0, stdout, stderr }),
        );
        child.stdin?.end(opts?.input ?? "");
      }),
  };
}

/** Runs the server package's pinned wrangler; throws on a non-zero exit. */
export function makeWrangler(
  deps: Deps,
  root: string,
  accountId: () => string | undefined,
) {
  return async (args: string[], input?: string): Promise<string> => {
    const id = accountId();
    const env = id ? { CLOUDFLARE_ACCOUNT_ID: id } : undefined;
    const pnpmArgs = [
      "--dir",
      join(root, "apps/server"),
      "exec",
      "wrangler",
      ...args,
    ];
    const r = await deps.exec("pnpm", pnpmArgs, { env, input });
    if (r.code !== 0)
      throw new Error(
        `wrangler ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`,
      );
    return r.stdout;
  };
}
export type Wrangler = ReturnType<typeof makeWrangler>;

const API = "https://api.cloudflare.com/client/v4";

async function wranglerToken(wrangler: Wrangler): Promise<string> {
  const out = await wrangler(["auth", "token", "--json"]);
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

/** Cloudflare v4 client. Token: CLOUDFLARE_API_TOKEN, else `wrangler auth token`. */
export function makeApi(deps: Deps, wrangler: Wrangler) {
  let token = deps.env.CLOUDFLARE_API_TOKEN;
  return async <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> => {
    token ??= await wranglerToken(wrangler);
    const res = await deps.fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      result?: T;
      errors?: { message: string }[];
    };
    if (!res.ok || !json.success) {
      const msg =
        json.errors?.map((e) => e.message).join("; ") || res.statusText;
      throw Object.assign(
        new Error(`${method} ${path}: ${res.status} ${msg}`),
        { status: res.status },
      );
    }
    return json.result as T;
  };
}
export type Api = ReturnType<typeof makeApi>;
