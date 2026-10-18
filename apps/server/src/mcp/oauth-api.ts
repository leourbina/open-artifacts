import {
  getOAuthApi,
  type OAuthHelpers,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { MCP_PATH } from "@oa/shared";
import type { Env } from "../env.js";
import { mcpResource } from "./server.js";

// The provider's configuration and its helpers, without the MCP handler, so
// services (member changes) can revoke grants without importing the server.

export const OAUTH = {
  authorize: "/oauth/authorize",
  token: "/oauth/token",
  register: "/oauth/register",
} as const;

/** OAuth access-token lifetime (24 h; the provider default is 1 h). */
export const ACCESS_TOKEN_TTL_S = 86_400;

export type ProviderOptions = OAuthProviderOptions<Env>;
type Handler = ProviderOptions["defaultHandler"];

export function providerOptions(
  env: Env,
  apiHandler: NonNullable<ProviderOptions["apiHandler"]>,
  defaultHandler: Handler,
): ProviderOptions {
  const resource = mcpResource(env);
  return {
    apiRoute: MCP_PATH,
    apiHandler,
    defaultHandler,
    authorizeEndpoint: OAUTH.authorize,
    tokenEndpoint: OAUTH.token,
    clientRegistrationEndpoint: OAUTH.register,
    // Each refresh costs 2 KV writes (Free plan: 1000/day): long-lived access
    // tokens keep agents from refreshing hourly.
    accessTokenTTL: ACCESS_TOKEN_TTL_S,
    resourceMetadata: {
      resource,
      authorization_servers: [new URL(resource).origin],
      bearer_methods_supported: ["header"],
      resource_name: "Open Artifacts",
    },
  };
}

const NO_HANDLER = { fetch: () => new Response(null, { status: 404 }) };

/** OAuth helpers (parse/consent/complete, grants) outside the provider's fetch. */
export const oauthApi = (env: Env): OAuthHelpers =>
  getOAuthApi(providerOptions(env, NO_HANDLER, NO_HANDLER), env);

/** Upper bound on grant pages walked per revocation (100 grants per page). */
const MAX_GRANT_PAGES = 10;

/**
 * Revokes every OAuth grant (and its tokens) the user holds. Re-lists from the
 * start each round, since revoked grants drop out of the listing.
 */
export async function revokeAllGrants(env: Env, userId: string): Promise<void> {
  const oauth = oauthApi(env);
  for (let page = 0; page < MAX_GRANT_PAGES; page++) {
    const { items } = await oauth.listUserGrants(userId, { limit: 100 });
    if (items.length === 0) return;
    await Promise.all(items.map((g) => oauth.revokeGrant(g.id, userId)));
  }
}
