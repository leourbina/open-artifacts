import { parseDomains } from "../../../packages/auth-core/src/domains.ts";

/**
 * Direct sign-in Worker vars (docs/self-hosting/direct-sign-in.md) and their
 * setup flags. The template has none: a deploy replaces the live vars, so
 * setup carries each one forward from the live Worker unless a flag sets it.
 */
export const SIGNIN = {
  AUTH_PROVIDERS: "auth-providers",
  AUTH_DOMAINS: "auth-domains",
  AUTH_DOMAIN_JOIN: "auth-domain-join",
  GOOGLE_CLIENT_ID: "google-client-id",
  TURNSTILE_SITE_KEY: "turnstile-site-key",
} as const;
export type SigninVar = keyof typeof SIGNIN;
export const SIGNIN_VARS = Object.keys(SIGNIN) as SigninVar[];
/** Values to render; "" is unset (not rendered: the server default). */
export type Signin = Record<SigninVar, string>;

/** apps/server/src/auth/config.ts PROVIDERS (test/signin.test.ts keeps them in sync). */
export const PROVIDERS = ["access", "google", "email"] as const;
const JOINS = ["invite", "member"];
const TOKEN = /^[!-~]+$/;

const parts = (v: string) =>
  v
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

/** Why one value is invalid on its own (empty is always fine: it clears). */
function valueProblems(name: SigninVar, v: string): string[] {
  if (v === "") return [];
  switch (name) {
    case "AUTH_PROVIDERS": {
      const ps = parts(v);
      if (!ps.length)
        return [
          "AUTH_PROVIDERS lists no provider (pass access to keep Access only, or empty to clear)",
        ];
      return ps
        .filter((p) => !(PROVIDERS as readonly string[]).includes(p))
        .map(
          (p) =>
            `AUTH_PROVIDERS: unknown provider ${JSON.stringify(p)} (expected ${PROVIDERS.join(", ")})`,
        );
    }
    case "AUTH_DOMAINS": {
      const { domains, invalid } = parseDomains(v);
      return [
        ...invalid.map(
          (d) => `AUTH_DOMAINS: invalid domain ${JSON.stringify(d)}`,
        ),
        ...(domains.length || invalid.length
          ? []
          : ["AUTH_DOMAINS lists no domain (pass empty to clear)"]),
      ];
    }
    case "AUTH_DOMAIN_JOIN":
      return JOINS.includes(v)
        ? []
        : [
            `AUTH_DOMAIN_JOIN: ${JSON.stringify(v)} (expected invite or member)`,
          ];
    default:
      return TOKEN.test(v)
        ? []
        : [`${name}: ${JSON.stringify(v)} has spaces or non-ASCII characters`];
  }
}

/** The canonical form of a valid value: trimmed, lists deduped and comma-joined. */
function normalize(name: SigninVar, v: string): string {
  if (name === "AUTH_PROVIDERS") return [...new Set(parts(v))].join(",");
  if (name === "AUTH_DOMAINS") return parseDomains(v).domains.join(",");
  return v.trim();
}

/** The provider list a value turns on; unset is Access only, as on the server. */
export const providersOf = (s: Signin) =>
  s.AUTH_PROVIDERS === "" ? ["access"] : parts(s.AUTH_PROVIDERS);

/** Every reason this combination would not serve the sign-in it asks for. */
export function signinProblems(s: Signin): string[] {
  const out = SIGNIN_VARS.flatMap((k) => valueProblems(k, s[k]));
  if (providersOf(s).includes("google")) {
    if (!s.GOOGLE_CLIENT_ID)
      out.push("google is in AUTH_PROVIDERS but GOOGLE_CLIENT_ID is empty");
    if (!parseDomains(s.AUTH_DOMAINS).domains.length)
      out.push("google is in AUTH_PROVIDERS but AUTH_DOMAINS is empty");
  }
  return out;
}

/** The sign-in flags given this run (an empty value clears); throws on a value invalid on its own. */
export function parseSigninFlags(v: Record<string, unknown>): Partial<Signin> {
  const out: Partial<Signin> = {};
  for (const name of SIGNIN_VARS) {
    const raw = v[SIGNIN[name]];
    if (typeof raw !== "string") continue;
    const why = valueProblems(name, raw.trim());
    if (why.length)
      throw new Error(`invalid --${SIGNIN[name]}: ${why.join("; ")}`);
    out[name] = normalize(name, raw);
  }
  return out;
}

/**
 * The sign-in vars to render: the flag, then the live Worker's value. With an
 * unreadable Worker (`live` undefined) the saved state stands in, and a var
 * with neither a flag nor a saved value is `missing`. Live and saved values
 * are normalized only when valid; invalid ones are kept as is for
 * signinProblems to refuse.
 */
export function resolveSignin(o: {
  flags: Partial<Signin>;
  live?: Map<string, string | undefined>;
  state?: Partial<Signin>;
}): {
  values: Signin;
  /** Flags that change a live value: [name, live, flag]. */
  changed: [SigninVar, string, string][];
  /** Names carried forward from the live Worker. */
  kept: SigninVar[];
  missing: SigninVar[];
} {
  const values = {} as Signin;
  const changed: [SigninVar, string, string][] = [];
  const kept: SigninVar[] = [];
  const missing: SigninVar[] = [];
  for (const name of SIGNIN_VARS) {
    const flag = o.flags[name];
    const other = o.live ? o.live.get(name)?.trim() : o.state?.[name];
    if (flag === undefined && other === undefined && !o.live)
      missing.push(name);
    const v = flag ?? other ?? "";
    values[name] = valueProblems(name, v).length ? v : normalize(name, v);
    const was = o.live?.get(name)?.trim() ?? "";
    if (flag !== undefined && o.live && flag !== was)
      changed.push([name, was, flag]);
    if (flag === undefined && o.live && was) kept.push(name);
  }
  return { values, changed, kept, missing };
}

/** Only the set values: what the rendered config and reports carry. */
export const setOnly = (s: Signin) =>
  Object.fromEntries(Object.entries(s).filter(([, v]) => v !== ""));
