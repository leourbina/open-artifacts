import { MCP_PATH } from "@oa/shared";
import { app } from "./app.js";
import { verifyPat } from "./auth/pat.js";
import { orgCan } from "./auth/policy.js";
import { contentApp } from "./content/app.js";
import { scheduled } from "./cron.js";
import type { Env } from "./env.js";
import { appHostOpts, withSecurityHeaders } from "./http/middleware.js";
import { serveAppHost } from "./mcp/oauth.js";
import {
  capMcpBody,
  createServer,
  mcpHandler,
  mcpUnauthorized,
} from "./mcp/server.js";
import { getUser } from "./services/users.js";

export type { Env } from "./env.js";
export { ArtifactRuntime } from "./runtime/do.js";

const normHost = (h: string) =>
  h.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");

const PAT_BEARER = /^\s*Bearer\s+(oa_pat_\S*)\s*$/i;

/** /mcp with `Authorization: Bearer oa_pat_…`: the token's user, attributed to its label. */
async function mcpWithPat(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  token: string,
): Promise<Response> {
  const pat = await verifyPat(env, token, ctx);
  const user = pat ? await getUser(env, pat.userId) : null;
  if (!pat || !user) return mcpUnauthorized(env);
  // Guests can't connect agents (they only see what's shared with them).
  if (!orgCan(user, "mcp.connect"))
    return mcpUnauthorized(env, "Only members can connect agents");
  const capped = await capMcpBody(req, env);
  if (capped instanceof Response) return capped;
  const agent = { name: pat.label, version: null };
  return mcpHandler(env, () =>
    createServer({ env, user, agent, exec: ctx }),
  ).fetch(capped, {
    // token is deliberately empty: tools never need it, and the SDK must not
    // be able to log or echo the PAT. clientId names the token row instead.
    authInfo: { token: "", clientId: `pat:${pat.tokenId}`, scopes: [] },
  });
}

export default {
  async fetch(req, env, ctx) {
    // URL.hostname only: port stripped; X-Forwarded-Host is ignored.
    const url = new URL(req.url);
    if (normHost(url.hostname) === normHost(env.CONTENT_HOST))
      return contentApp.fetch(req, env, ctx);
    const pat =
      url.pathname === MCP_PATH
        ? PAT_BEARER.exec(req.headers.get("authorization") ?? "")
        : null;
    // PATs at /mcp; everything else through the OAuth provider: OAuth bearer
    // at /mcp, its token/register/metadata endpoints, then the app.
    const res = pat?.[1]
      ? await mcpWithPat(req, env, ctx, pat[1])
      : await serveAppHost(req, env, ctx, app);
    return withSecurityHeaders(res, appHostOpts(env, req.method, url.pathname));
  },
  scheduled,
} satisfies ExportedHandler<Env>;
