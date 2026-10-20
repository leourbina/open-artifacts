import { isId } from "../../../packages/shared/src/ids.ts";

type Tunable = {
  /** Why a value is invalid; undefined when it is fine. The empty value (clear) is always allowed. */
  check: (value: string) => string | undefined;
};

const ORIGIN =
  /^https:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?(:\d{1,5})?$/i;
const int =
  (min: number, max = Number.MAX_SAFE_INTEGER) =>
  (v: string) => {
    const n = /^[1-9]\d*$/.test(v) ? Number(v) : Number.NaN;
    if (!(n >= min && n <= max))
      return max === Number.MAX_SAFE_INTEGER
        ? `expected a positive integer`
        : `expected an integer from ${min} to ${max}`;
  };

/** The optional Worker vars setup keeps across deploys: one validator per name. */
export const TUNABLES: Record<string, Tunable> = {
  PUBLIC_HOME: {
    check: (v) => (v === "" || isId(v) ? undefined : "expected an artifact id"),
  },
  EMBED_ORIGINS: {
    check: (v) =>
      v === "" || v.split(",").every((o) => ORIGIN.test(o))
        ? undefined
        : "expected comma-separated https://host[:port] origins (no paths, wildcards or spaces)",
  },
  ANON_WRITES_PER_MIN: { check: int(1, 600) },
  DATA_DOC_BYTES: { check: int(1) },
  DATA_DAILY_WRITES: { check: int(1) },
};

/** `--var NAME=value` (repeatable; the last one for a name wins; `NAME=` clears). Throws on an unknown name or invalid value. */
export function parseVarFlags(
  raw: string[] | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of raw ?? []) {
    const i = item.indexOf("=");
    if (i < 1)
      throw new Error(
        `invalid --var ${JSON.stringify(item)}: expected NAME=value (NAME= clears)`,
      );
    const name = item.slice(0, i);
    const value = item.slice(i + 1);
    const t = Object.hasOwn(TUNABLES, name) ? TUNABLES[name] : undefined;
    if (!t)
      throw new Error(
        `unknown --var name ${JSON.stringify(name)} (allowed: ${Object.keys(TUNABLES).join(", ")})`,
      );
    const why = value === "" ? undefined : t.check(value);
    if (why)
      throw new Error(`invalid --var ${name}=${JSON.stringify(value)}: ${why}`);
    out[name] = value;
  }
  return out;
}

/**
 * The vars to render: the flag, then saved state, then the live Worker's value,
 * else the template default. An empty flag or saved value clears. `kept` lists
 * the values that came only from the live Worker (set in the dashboard).
 */
export function resolveVars(o: {
  flags: Record<string, string>;
  state: Record<string, string>;
  live: Record<string, string | undefined>;
}): { values: Record<string, string>; kept: string[] } {
  const values: Record<string, string> = {};
  const kept: string[] = [];
  for (const name of Object.keys(TUNABLES)) {
    const live = o.live[name]?.trim() || undefined;
    const v = o.flags[name] ?? o.state[name] ?? live;
    if (v === undefined) continue;
    values[name] = v;
    if (o.flags[name] === undefined && o.state[name] === undefined && live)
      kept.push(`${name}=${live}`);
  }
  return { values, kept };
}
