import { parseArgs } from "node:util";
import { type Deps, realFs } from "./cf.ts";
import { homeOf } from "./secret-file.ts";
import type { State } from "./state.ts";
import { NeedInput } from "./step.ts";

/** Each token: its env var, the flag that names a file, and the default file's suffix. */
const TOKENS = [
  ["CLOUDFLARE_API_TOKEN", "token-file", "cloudflare"],
  ["OA_ACCESS_TOKEN", "access-token-file", "access"],
  ["ANALYTICS_TOKEN", "analytics-token-file", "analytics"],
] as const;

/**
 * Tokens from 0600 files, so they never enter a chat. Per token: the env var,
 * then the flag's file, then ~/.open-artifacts/<name>-<kind>-token; the first
 * that exists wins. The result is deps with those tokens in `env` (never in
 * argv); the deploy token also goes to wrangler children. Values are never
 * echoed, stored or put in a message.
 */
export function withTokenFiles(argv: string[], deps: Deps, state: State): Deps {
  const { values: v } = parseArgs({
    args: argv,
    strict: false,
    options: {
      name: { type: "string" },
      "token-file": { type: "string" },
      "access-token-file": { type: "string" },
      "analytics-token-file": { type: "string" },
    },
  });
  const fs = deps.fs ?? realFs;
  const home = homeOf(deps.env);
  const install =
    (v.name as string | undefined) ?? state.name ?? "open-artifacts";
  // A path with no "/" may be a token pasted by mistake: never echo it.
  const shown = (path: string) =>
    path.includes("/") ? path : "the token file you passed";
  const read = (path: string, explicit: boolean) => {
    const at = shown(path);
    const f = fs.readToken?.(path);
    if (f === null) {
      if (explicit) throw new Error(`token file not found: ${at}`);
      return undefined;
    }
    if (f === undefined || process.getuid === undefined)
      throw new NeedInput(
        `cannot check the permissions of ${at} on this platform (use WSL on Windows)`,
      );
    if (!f.isFile || f.uid !== process.getuid())
      throw new NeedInput(
        `${at} must be a regular file you own (symlinks are refused)`,
      );
    if (f.mode & 0o077)
      throw new NeedInput(
        `${at} is readable by others; run chmod 600 ${path.includes("/") ? path : "on it"}`,
      );
    const token = f.text.trim();
    if (!token) throw new NeedInput(`${at} is empty; save the token again`);
    if (!/^[\x21-\x7e]+$/.test(token))
      throw new NeedInput(`${at}: the token must be one line`);
    return token;
  };
  const env = { ...deps.env };
  let childEnv: Record<string, string> | undefined;
  for (const [name, flag, kind] of TOKENS) {
    if (env[name]?.trim()) continue;
    const given = v[flag];
    const path =
      typeof given === "string" ? given.replace(/^~(?=\/|$)/, home) : undefined;
    const token = path
      ? read(path, true)
      : read(`${home}/.open-artifacts/${install}-${kind}-token`, false);
    if (!token) continue;
    env[name] = token;
    if (name === "CLOUDFLARE_API_TOKEN")
      childEnv = { ...deps.childEnv, [name]: token };
  }
  return { ...deps, env, ...(childEnv ? { childEnv } : {}) };
}
