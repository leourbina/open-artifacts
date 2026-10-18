import type { Deps } from "./cf.ts";

/** One SELECT statement, at most a trailing semicolon. */
const SELECT = /^\s*SELECT\b[^;]*;?\s*$/i;
const eq = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The wrangler argv shapes --check may run, matched exactly: whoami, auth
 * token, secret list, and a single remote `d1 execute --command SELECT`.
 */
export function wranglerReadOnly(a: string[]): boolean {
  if (eq(a, ["whoami", "--json"]) || eq(a, ["auth", "token", "--json"]))
    return true;
  if (a.length === 6 && a[0] === "secret" && a[1] === "list")
    return eq(a, ["secret", "list", "--name", a[3], "--format", "json"]);
  if (a.length === 7 && a[0] === "d1" && a[1] === "execute")
    return (
      eq(a.slice(3, 6), ["--remote", "--json", "--command"]) &&
      !a[2].startsWith("-") &&
      SELECT.test(a[6])
    );
  return false;
}

/** Processes --check may start: `pnpm --version` and read-only wrangler. */
export function execReadOnly(cmd: string, args: string[]): boolean {
  if (cmd !== "pnpm") return false;
  if (eq(args, ["--version"])) return true;
  return (
    args[0] === "--dir" &&
    args[2] === "exec" &&
    args[3] === "wrangler" &&
    wranglerReadOnly(args.slice(4))
  );
}

export const refuse = (what: string) =>
  new Error(`--check is read-only: refused ${what}`);

/** Deps whose fetch allows GET only and whose exec allows the read-only list. */
export function readOnlyDeps(deps: Deps): Deps {
  const fetchRo = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const req = input instanceof Request ? input : undefined;
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    if (method !== "GET")
      throw refuse(`${method} ${new URL(req?.url ?? String(input)).pathname}`);
    return deps.fetch(input, init);
  };
  return {
    ...deps,
    fetch: fetchRo as typeof fetch,
    exec: async (cmd, args, opts) => {
      if (!execReadOnly(cmd, args)) {
        const i = args.indexOf("wrangler");
        throw refuse(
          i >= 0
            ? `wrangler ${args.slice(i + 1, i + 4).join(" ")}`
            : `${cmd} ${args.slice(0, 4).join(" ")}`,
        );
      }
      return deps.exec(cmd, args, opts);
    },
  };
}
