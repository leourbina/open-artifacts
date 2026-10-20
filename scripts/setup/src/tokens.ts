/**
 * The Cloudflare API tokens setup needs: one table, the single source of truth
 * for --token-links, --token-page, the prereqs token report, and every token
 * link setup prints. The permission keys are the dashboard's
 * `permissionGroupKeys` (developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/).
 *
 * No email token: the send_email binding deploys with Workers Scripts: Edit,
 * and the sending domain is onboarded in the dashboard (no API), so a team
 * install needs no extra permission.
 */

export type Perm = {
  key: string;
  type: "read" | "edit";
  label: string;
  /** false: setup works without it (its absence is a note, never a lack). */
  required?: false;
  /** Why an optional permission helps. */
  note?: string;
};
export type Zone = { id: string; name: string };
export type ZoneScope = { mode: "specific"; zones: string[] };
export type Ids = { accountId?: string; zones?: Zone[] };
export type StoreAs =
  | { kind: "env"; name: string; command: string }
  | { kind: "gh-secret"; name: string; command: string };
export type Token = {
  id: "deploy" | "access" | "analytics";
  name: string;
  purpose: string;
  permissions: Perm[];
  storeAs: StoreAs;
  /** Saves the token hidden at ~/.open-artifacts/<install>-<kind>-token, mode 0600. */
  saveCommand: string;
  next: string;
  required: boolean;
};
export type LinkedToken = Token & { url: string; zoneScope?: ZoneScope };

/**
 * Zone-level permission groups. The dashboard ignores the link's zoneId (Zone
 * Resources stays "All zones"), so zoneScope names the zones to pick by hand.
 */
export const ZONE_KEYS = new Set(["zone", "dns", "workers_routes"]);

const DEPLOY: Perm[] = [
  { key: "workers_scripts", type: "edit", label: "Workers Scripts: Edit" },
  {
    key: "workers_kv_storage",
    type: "edit",
    label: "Workers KV Storage: Edit",
  },
  { key: "workers_r2", type: "edit", label: "Workers R2 Storage: Edit" },
  { key: "d1", type: "edit", label: "D1: Edit" },
  {
    key: "billing",
    type: "read",
    label: "Billing: Read",
    required: false,
    note: "lets setup detect your plan",
  },
  { key: "zone", type: "read", label: "Zone: Read" },
  { key: "workers_routes", type: "edit", label: "Workers Routes: Edit" },
  { key: "dns", type: "edit", label: "DNS: Edit" },
];
const ACCESS: Perm[] = [
  { key: "access", type: "edit", label: "Access: Apps and Policies: Edit" },
  { key: "access_acct", type: "read", label: "Access: Organizations: Read" },
];
const ANALYTICS: Perm[] = [
  { key: "account_analytics", type: "read", label: "Account Analytics: Read" },
];

/** The env var setup reads each token from (also its GitHub secret name). */
export const ENV_NAME = {
  deploy: "CLOUDFLARE_API_TOKEN",
  access: "OA_ACCESS_TOKEN",
  analytics: "ANALYTICS_TOKEN",
} as const;

/** The one line the user runs in their own terminal: reads the token hidden, saves it 0600. */
export const saveCommand = (file: string, label: string) =>
  `bash -c 'set -e; umask 077; d="$HOME/.open-artifacts"; mkdir -p "$d"; chmod 700 "$d"; read -rsp "${label} (hidden, then Enter): " T; echo; [ -n "$T" ] || { echo "nothing entered; not saved"; exit 1; }; rm -f "$d/${file}-token"; printf "%s" "$T" > "$d/${file}-token"; chmod 600 "$d/${file}-token"; echo "saved to $d/${file}-token"'`;

export type TokenOpts = {
  /** Install name, the token name prefix; default open-artifacts. */
  name?: string;
  /** owner/repo: store each token as a GitHub secret there instead of an env var. */
  repo?: string;
};

/** The table, in order: deploy, access, analytics. */
export function tokens(o: TokenOpts = {}): Token[] {
  const prefix = o.name || "open-artifacts";
  // The name sits inside a single-quoted bash line: keep it to shell-safe characters.
  const safe = prefix.replace(/[^\w.-]/g, "_");
  const save = (kind: string, label: string) =>
    saveCommand(`${safe}-${kind}`, label);
  const store = (name: string, kind: string, label: string): StoreAs =>
    o.repo
      ? {
          kind: "gh-secret",
          name,
          command: `gh secret set ${name} -R ${o.repo}`,
        }
      : { kind: "env", name, command: save(kind, label) };
  return [
    {
      id: "deploy",
      name: `${prefix} deploy`,
      purpose:
        "Setup uses this to create the Worker, database, file storage and routes on your Cloudflare account, and to read your Workers plan. It's only needed while setting up and updating.",
      permissions: DEPLOY,
      storeAs: store(ENV_NAME.deploy, "cloudflare", "Cloudflare deploy token"),
      saveCommand: save("cloudflare", "Cloudflare deploy token"),
      next: "Rerun setup: it reads the saved file, then checks each permission. Without it, setup uses your `wrangler login`.",
      required: true,
    },
    {
      id: "access",
      name: `${prefix} access`,
      purpose:
        "Setup uses this to put Cloudflare Access sign-in in front of your instance, so only people you allow can open it.",
      permissions: ACCESS,
      storeAs: store(ENV_NAME.access, "access", "Cloudflare Access token"),
      saveCommand: save("access", "Cloudflare Access token"),
      next: "Rerun setup: the access step uses it for every Access call.",
      required: true,
    },
    {
      id: "analytics",
      name: `${prefix} analytics`,
      purpose:
        "The dashboard's Usage page reads Cloudflare analytics to show requests and database use against your plan's limits. This token is read-only and does nothing else.",
      permissions: ANALYTICS,
      storeAs: store(
        ENV_NAME.analytics,
        "analytics",
        "Cloudflare analytics token",
      ),
      saveCommand: save("analytics", "Cloudflare analytics token"),
      next: "Rerun setup: the secrets step stores it as the Worker secret ANALYTICS_TOKEN.",
      required: false,
    },
  ];
}

export const tokenById = (id: Token["id"], o?: TokenOpts) =>
  tokens(o).find((t) => t.id === id) as Token;

/** The dashboard's create-token form, pre-filled; unknown params are omitted. */
export function tokenUrl(
  perms: Pick<Perm, "key" | "type">[],
  o: { accountId?: string; zoneId?: string; name?: string } = {},
): string {
  const keys = JSON.stringify(perms.map(({ key, type }) => ({ key, type })));
  const q = [`permissionGroupKeys=${encodeURIComponent(keys)}`];
  for (const k of ["accountId", "zoneId", "name"] as const)
    if (o[k]) q.push(`${k}=${encodeURIComponent(o[k] as string)}`);
  return `https://dash.cloudflare.com/profile/api-tokens?${q.join("&")}`;
}

export const zoneScoped = (t: Token) =>
  t.permissions.some((p) => ZONE_KEYS.has(p.key));

/** The zones a zone-scoped token must cover, by name; undefined when unknown or not zoned. */
export const zoneScopeFor = (
  t: Token,
  zones?: Zone[],
): ZoneScope | undefined =>
  zoneScoped(t) && zones?.length
    ? { mode: "specific", zones: [...new Set(zones.map((z) => z.name))] }
    : undefined;

/** A token's link. zoneId (harmless, ignored by the dashboard) only for a single zone. */
export const linkFor = (t: Token, ids: Ids = {}) =>
  tokenUrl(t.permissions, {
    accountId: ids.accountId,
    zoneId:
      zoneScoped(t) && ids.zones?.length === 1 ? ids.zones[0]?.id : undefined,
    name: t.name,
  });

export const withUrls = (list: Token[], ids: Ids = {}): LinkedToken[] =>
  list.map((t) => {
    const zoneScope = zoneScopeFor(t, ids.zones);
    return { ...t, url: linkFor(t, ids), ...(zoneScope ? { zoneScope } : {}) };
  });
