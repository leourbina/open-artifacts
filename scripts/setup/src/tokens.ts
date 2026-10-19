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

export type Perm = { key: string; type: "read" | "edit"; label: string };
export type StoreAs =
  | { kind: "env"; name: string }
  | { kind: "gh-secret"; name: string; command: string };
export type Token = {
  id: "deploy" | "access" | "analytics";
  name: string;
  purpose: string;
  permissions: Perm[];
  storeAs: StoreAs;
  next: string;
  required: boolean;
};
export type LinkedToken = Token & { url: string };

/** Zone-level permission groups: the link scopes them to the zone when known. */
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
  { key: "billing", type: "read", label: "Billing: Read" },
  { key: "zone", type: "read", label: "Zone: Read" },
  { key: "workers_routes", type: "edit", label: "Workers Routes: Edit" },
  { key: "dns", type: "edit", label: "DNS: Edit" },
];
const ACCESS: Perm[] = [
  { key: "access", type: "edit", label: "Access: Apps and Policies: Edit" },
  { key: "access_acct", type: "read", label: "Access: Organizations: Read" },
  { key: "dns", type: "read", label: "DNS: Read" },
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

export type TokenOpts = {
  /** Install name, the token name prefix; default open-artifacts. */
  name?: string;
  /** owner/repo: store each token as a GitHub secret there instead of an env var. */
  repo?: string;
};

/** The table, in order: deploy, access, analytics. */
export function tokens(o: TokenOpts = {}): Token[] {
  const prefix = o.name || "open-artifacts";
  const store = (name: string): StoreAs =>
    o.repo
      ? {
          kind: "gh-secret",
          name,
          command: `gh secret set ${name} -R ${o.repo}`,
        }
      : { kind: "env", name };
  return [
    {
      id: "deploy",
      name: `${prefix} deploy`,
      purpose:
        "Setup uses this to create the Worker, database, file storage and routes on your Cloudflare account, and to read your Workers plan. It's only needed while setting up and updating.",
      permissions: DEPLOY,
      storeAs: store(ENV_NAME.deploy),
      next: "Rerun setup: prereqs checks each permission. Without it, setup uses your `wrangler login`.",
      required: true,
    },
    {
      id: "access",
      name: `${prefix} access`,
      purpose:
        "Setup uses this to put Cloudflare Access sign-in in front of your instance, so only people you allow can open it.",
      permissions: ACCESS,
      storeAs: store(ENV_NAME.access),
      next: "Rerun setup: the access step uses it for every Access call.",
      required: true,
    },
    {
      id: "analytics",
      name: `${prefix} analytics`,
      purpose:
        "The dashboard's Usage page reads Cloudflare analytics to show requests and database use against your plan's limits. This token is read-only and does nothing else.",
      permissions: ANALYTICS,
      storeAs: store(ENV_NAME.analytics),
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

/** A token's link; the zone id only for a token with zone permissions. */
export const linkFor = (
  t: Token,
  ids: { accountId?: string; zoneId?: string } = {},
) =>
  tokenUrl(t.permissions, {
    accountId: ids.accountId,
    zoneId: t.permissions.some((p) => ZONE_KEYS.has(p.key))
      ? ids.zoneId
      : undefined,
    name: t.name,
  });

export const withUrls = (
  list: Token[],
  ids: { accountId?: string; zoneId?: string } = {},
): LinkedToken[] => list.map((t) => ({ ...t, url: linkFor(t, ids) }));
