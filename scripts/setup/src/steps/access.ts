import type { State } from "../state.ts";
import type { ActionRequired, Ctx, Step } from "../step.ts";
import { writeConfig } from "./resources.ts";
import { ACCESS_SECRET, listSecrets, putSecret } from "./secrets.ts";

// Ported from scripts/ops/staging-access.ts (B4).
export const POLICY_NAME = "Open Artifacts – everyone";
const POLICY_BODY = {
  name: POLICY_NAME,
  decision: "allow",
  include: [{ everyone: {} }],
  exclude: [],
  require: [],
  approval_required: false,
  isolation_required: false,
  purpose_justification_required: false,
};
const CARRY_OVER = ["session_duration"] as const;
const perms = [
  { key: "access", type: "edit" }, // Access: Apps and Policies Edit
  { key: "access_acct", type: "read" }, // Access: Organizations Read
  { key: "dns", type: "read" }, // Zone: DNS Read
];
export const TOKEN_URL = `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(JSON.stringify(perms))}&accountId=*&zoneId=all&name=${encodeURIComponent("Open Artifacts setup")}`;
const ZERO_TRUST = "https://one.dash.cloudflare.com/";

// biome-ignore lint/suspicious/noExplicitAny: untyped API objects
type Obj = any;
const AR = (message: string, data?: unknown): ActionRequired => ({
  status: "action_required",
  message,
  data,
});
const status = (e: unknown) => (e as { status?: number }).status;
const empty = (x: unknown) => x == null || (Array.isArray(x) && x.length === 0);
const isEveryone = (inc: unknown) =>
  Array.isArray(inc) &&
  inc.length === 1 &&
  JSON.stringify(inc[0]) === '{"everyone":{}}';
const policyMatches = (p: Obj) =>
  p.decision === "allow" &&
  isEveryone(p.include) &&
  empty(p.exclude) &&
  empty(p.require) &&
  !p.approval_required &&
  !p.isolation_required &&
  !p.purpose_justification_required;

async function lookup(ctx: Ctx, accountId: string) {
  const a = `/accounts/${accountId}/access`;
  const org = await ctx.api<{ auth_domain?: string } | null>(
    "GET",
    `${a}/organizations`,
  );
  const policy = (await ctx.api.all<Obj>(`${a}/policies`)).find(
    (p) => p.name === POLICY_NAME,
  );
  const app = (await ctx.api.all<Obj>(`${a}/apps`)).find(
    (x) => x.name === ctx.opts.name,
  );
  return {
    a,
    domain: org?.auth_domain,
    policy,
    app,
    have: await listSecrets(ctx),
  };
}

function record(state: State, ctx: Ctx, teamDomain: string, app: Obj) {
  Object.assign(state, {
    teamDomain,
    accessAppId: app.id,
    accessClientId: app.saas_app.client_id,
  });
  writeConfig(state, ctx);
}

/** Org lookup with the wrangler token; on 403, ask for a scoped token (memory only). */
async function lookupWithToken(ctx: Ctx, accountId: string) {
  const denied = AR(
    "The wrangler login token cannot read Access. Create a token (Access: Apps and Policies Edit; Access: Organizations Read; Zone: DNS Read), then rerun interactively and paste it, or set CLOUDFLARE_API_TOKEN.",
    { url: TOKEN_URL },
  );
  try {
    return await lookup(ctx, accountId);
  } catch (e) {
    if (status(e) !== 403) throw e;
    if (ctx.opts.yes) return denied;
    const q = `Paste a CF_API_TOKEN (input hidden; create one at ${TOKEN_URL}):`;
    const token = await ctx.deps.prompt(q, { secret: true });
    if (!token) return denied;
    ctx.api.setToken(token);
    try {
      return await lookup(ctx, accountId);
    } catch (e2) {
      if (status(e2) === 403) return denied;
      throw e2;
    }
  }
}

export const access: Step = {
  name: "access",
  async check(state, ctx) {
    if (
      ctx.opts.upgrade &&
      state.accessAppId &&
      state.accessClientId &&
      state.teamDomain
    )
      return (await listSecrets(ctx)).has(ACCESS_SECRET) ? "done" : "todo";
    const l = await lookup(ctx, state.accountId ?? "").catch((e) => {
      if (status(e) === 403) return undefined;
      throw e;
    });
    const linked = l?.app?.policies?.some((p: Obj) => p.id === l.policy?.id);
    if (
      !l?.domain ||
      !l.policy ||
      !policyMatches(l.policy) ||
      !linked ||
      !l.app.saas_app?.client_id ||
      !l.have.has(ACCESS_SECRET)
    )
      return "todo";
    record(state, ctx, l.domain, l.app);
    return "done";
  },
  async apply(state, ctx) {
    // Preflight: nothing here touches the app until every check has passed.
    const l = await lookupWithToken(ctx, state.accountId ?? "");
    if ("status" in l) return l;
    if (!l.domain)
      return AR(
        `No Zero Trust organization on this account: open ${ZERO_TRUST}, enable Zero Trust (free), then rerun.`,
        { url: ZERO_TRUST },
      );
    let policyId: string = l.policy?.id;
    if (!l.policy)
      policyId = (await ctx.api<Obj>("POST", `${l.a}/policies`, POLICY_BODY))
        .id;
    else if (!policyMatches(l.policy)) {
      const kept = Object.fromEntries(
        CARRY_OVER.filter((k) => l.policy[k] !== undefined).map((k) => [
          k,
          l.policy[k],
        ]),
      );
      await ctx.api("PUT", `${l.a}/policies/${policyId}`, {
        ...kept,
        ...POLICY_BODY,
      });
    }
    const where = `Zero Trust > Access > Applications > ${ctx.opts.name}`;
    if (l.app) {
      // Never PUT an existing app: a full replace would drop dashboard edits.
      if (!l.app.policies?.some((p: Obj) => p.id === policyId))
        return AR(
          `Access app ${ctx.opts.name} is not linked to policy "${POLICY_NAME}". Attach it in ${where} > Policies, or delete the app, then rerun.`,
        );
      if (!l.app.saas_app?.client_id)
        throw new Error(
          `Access app ${ctx.opts.name} has no saas_app.client_id`,
        );
      if (!l.have.has(ACCESS_SECRET))
        return AR(
          `${ACCESS_SECRET} is missing on the Worker and can't be recovered: the API returns the client secret only on create. Delete the Access app (${where}), then rerun.`,
        );
      record(state, ctx, l.domain, l.app);
      return undefined;
    }
    const created = await ctx.api<Obj>("POST", `${l.a}/apps`, {
      name: ctx.opts.name,
      type: "saas",
      policies: [{ id: policyId, precedence: 1 }],
      saas_app: {
        auth_type: "oidc",
        redirect_uris: [`https://${ctx.opts.appHost}/auth/callback`],
        grant_types: ["authorization_code_with_pkce"],
        allow_pkce_without_client_secret: false,
        scopes: ["openid", "email", "profile"],
      },
    });
    try {
      const secret = created?.saas_app?.client_secret;
      if (typeof secret !== "string" || !secret || !created.saas_app.client_id)
        throw new Error(
          "create response lacks saas_app.client_secret or client_id",
        );
      await putSecret(ctx, ACCESS_SECRET, secret);
      record(state, ctx, l.domain, created);
    } catch (e) {
      // The client secret is unrecoverable once lost: undo the create.
      await ctx.api("DELETE", `${l.a}/apps/${created.id}`).catch(() => {
        (e as Error).message +=
          `; rollback failed: DELETE of Access app ${created.id} also failed, delete it in ${where}`;
      });
      throw e;
    }
    return undefined;
  },
};
