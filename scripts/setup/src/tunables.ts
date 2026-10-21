import {
  normalizeVar,
  TUNABLES,
} from "../../../packages/shared/src/tunables.ts";

export { normalizeVar, TUNABLES };

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
    out[name] = normalizeVar(name, value);
  }
  return out;
}

/**
 * The vars to render: the flag, then saved state, then the live Worker's value,
 * else the template default. An empty flag or saved value clears. `kept` lists
 * the values that came only from the live Worker (set in the dashboard);
 * `ignored` / `ignoredSaved` list live / saved values that failed validation and were dropped.
 */
export function resolveVars(o: {
  flags: Record<string, string>;
  state: Record<string, string>;
  live: Record<string, string | undefined>;
}): {
  values: Record<string, string>;
  kept: string[];
  ignored: string[];
  ignoredSaved: string[];
} {
  const values: Record<string, string> = {};
  const kept: string[] = [];
  const ignored: string[] = [];
  const ignoredSaved: string[] = [];
  for (const name of Object.keys(TUNABLES)) {
    let live = o.live[name]?.trim() || undefined;
    if (live && TUNABLES[name]?.check(live)) {
      ignored.push(name);
      live = undefined;
    }
    let saved: string | undefined = o.state[name];
    if (saved && TUNABLES[name]?.check(saved)) {
      ignoredSaved.push(name);
      saved = undefined;
    }
    const v = o.flags[name] ?? saved ?? live;
    if (v === undefined) continue;
    values[name] = normalizeVar(name, v);
    if (o.flags[name] === undefined && saved === undefined && live)
      kept.push(`${name}=${live}`);
  }
  return { values, kept, ignored, ignoredSaved };
}
