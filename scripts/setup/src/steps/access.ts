import { makeApi } from "../cf.ts";
import { type State, writeState } from "../state.ts";
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
export const TOKEN_URL = `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(
  JSON.stringify(perms),
)}&accountId=*&zoneId=all&name=${encodeURIComponent("Open Artifacts setup")}`;
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
const callback = (ctx: Ctx) => `https://${ctx.opts.appHost}/auth/callback`;
const linked = (app: Obj, policyId?: string) =>
  Boolean(policyId) && app.policies?.some((p: Obj) => p.id === policyId);

const HOST = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const TEAM = /(?:^|\/\/)([a-z0-9-]+\.cloudflareaccess\.com)(?=$|[/:?#])/i;

/**
 * The team domain from the Access app object, when a field carries it. The
 * documented OIDC `saas_app` has none; SAML's `sso_endpoint`/`idp_entity_id`
 * do, and the app's `domain` does when the API returns it.
 */
export function teamDomainOf(app: Obj): string | undefined {
  const fields = [
    app?.domain,
    app?.saas_app?.issuer,
    app?.saas_app?.sso_endpoint,
    app?.saas_app?.idp_entity_id,
  ];
  for (const v of fields) {
    const m = typeof v === "string" ? v.match(TEAM) : null;
    if (m) return m[1].toLowerCase();
  }
  return undefined;
}

/** OA_TEAM_DOMAIN (a non-secret CI variable), as a bare host. */
function envTeamDomain(ctx: Ctx): string | undefined {
  const raw = ctx.deps.env.OA_TEAM_DOMAIN?.trim();
  if (!raw) return undefined;
  const host = raw.replace(/^https:\/\//i, "").replace(/\/+$/, "");
  if (!HOST.test(host))
    throw new Error(
      `invalid OA_TEAM_DOMAIN: ${JSON.stringify(raw)} (expected <team>.cloudflareaccess.com)`,
    );
  return host.toLowerCase();
}

/** Thrown when only the organization (team domain) is unreadable. */
const orgDenied = () =>
  Object.assign(new Error("GET organizations: 403"), {
    status: 403,
    teamDomain: true,
  });

/** Finds the policy and app by name; the team domain from the app, the organization, then OA_TEAM_DOMAIN. */
async function lookup(ctx: Ctx, accountId: string) {
  const a = `/accounts/${accountId}/access`;
  const policy = (await ctx.accessApi.all<Obj>(`${a}/policies`)).find(
    (p) => p.name === POLICY_NAME,
  );
  const app = (await ctx.accessApi.all<Obj>(`${a}/apps`)).find(
    (x) => x.name === ctx.opts.name,
  );
  let domain = app && teamDomainOf(app);
  if (!domain) {
    let forbidden = false;
    // A 404 or a null result both mean "no Zero Trust organization".
    const org = await ctx
      .accessApi<{ auth_domain?: string } | null>("GET", `${a}/organizations`)
      .catch((e) => {
        if (status(e) === 404) return null;
        if (status(e) !== 403) throw e;
        forbidden = true;
        return null;
      });
    // A token without Access scopes lists no apps instead of a 403: with the
    // organization also denied, an empty list proves nothing, so never fall back.
    if (forbidden && !app)
      throw Object.assign(new Error("GET organizations: 403, no apps"), {
        status: 403,
      });
    domain = org?.auth_domain ?? (forbidden ? envTeamDomain(ctx) : undefined);
    if (forbidden && !domain) throw orgDenied();
  }
  return { a, domain, policy, app, have: await listSecrets(ctx) };
}

function record(state: State, ctx: Ctx, teamDomain: string, app: Obj) {
  Object.assign(state, {
    teamDomain,
    accessAppId: app.id,
    accessClientId: app.saas_app.client_id,
  });
  delete state.pendingAccessAppId;
  writeConfig(state, ctx);
  if (!app.saas_app.redirect_uris?.includes(callback(ctx)))
    ctx.notes.push(
      `warning: Access app ${app.name} redirect_uris lack ${callback(
        ctx,
      )}; add it in the dashboard`,
    );
}

/** Lookup with OA_ACCESS_TOKEN or the wrangler token; on 403, ask once (memory only). */
async function lookupWithToken(ctx: Ctx, accountId: string) {
  const how = ctx.opts.interactive
    ? "run `read -rs OA_ACCESS_TOKEN; export OA_ACCESS_TOKEN`, or rerun interactively and paste it (kept in memory only)"
    : "run `read -rs OA_ACCESS_TOKEN; export OA_ACCESS_TOKEN` (non-interactive/--json)";
  const create = `Create one (Access: Apps and Policies Edit; Access: Organizations Read; Zone: DNS Read), then ${how}`;
  const deny = (e: unknown) =>
    AR(
      (e as { teamDomain?: boolean }).teamDomain
        ? `This token cannot read the Access organization, so the team domain is unknown. Set OA_TEAM_DOMAIN=<team>.cloudflareaccess.com, or ${create[0].toLowerCase()}${create.slice(1)}.`
        : `This token cannot read Access. ${create}. (OA_TEAM_DOMAIN can stand in for Organizations Read.)`,
      { url: TOKEN_URL },
    );
  try {
    return await lookup(ctx, accountId);
  } catch (e) {
    if (status(e) !== 403) throw e;
    if (!ctx.opts.interactive) return deny(e);
    const q = `Paste an OA_ACCESS_TOKEN (input hidden; create one at ${TOKEN_URL}):`;
    const token = await ctx.deps.prompt(q, { secret: true });
    if (!token) return deny(e);
    ctx.accessApi = makeApi(ctx.deps, ctx.wrangler, token);
    try {
      return await lookup(ctx, accountId);
    } catch (e2) {
      if (status(e2) === 403) return deny(e2);
      throw e2;
    }
  }
}

/** POST the app and put its client secret as one interruption-safe unit. */
async function create(
  state: State,
  ctx: Ctx,
  a: string,
  policyId: string,
  domain: string,
) {
  let interrupted = false;
  // First Ctrl-C: let the rollback run. Second: exit now, naming what may be orphaned.
  const onSigint = () => {
    if (interrupted) {
      const id = state.pendingAccessAppId ?? "unknown (POST in flight)";
      process.stderr.write(
        `\nSecond interrupt: exiting. Access app ${ctx.opts.name} (${id}) may be orphaned; pendingAccessAppId in .openartifacts/state.json lets the next run delete and recreate it.\n`,
      );
      process.exit(130);
    }
    interrupted = true;
  };
  process.on("SIGINT", onSigint);
  try {
    const created = await ctx.accessApi<Obj>("POST", `${a}/apps`, {
      name: ctx.opts.name,
      type: "saas",
      policies: [{ id: policyId, precedence: 1 }],
      saas_app: {
        auth_type: "oidc",
        redirect_uris: [callback(ctx)],
        grant_types: ["authorization_code_with_pkce"],
        allow_pkce_without_client_secret: false,
        scopes: ["openid", "email", "profile"],
      },
    });
    state.pendingAccessAppId = created.id;
    writeState(ctx.fs, ctx.root, state);
    try {
      const secret = created?.saas_app?.client_secret;
      if (typeof secret !== "string" || !secret || !created.saas_app.client_id)
        throw new Error(
          "create response lacks saas_app.client_secret or client_id",
        );
      await putSecret(ctx, ACCESS_SECRET, secret);
      if (interrupted)
        throw new Error("interrupted (SIGINT); Access app rolled back");
      record(state, ctx, domain, created);
    } catch (e) {
      // The client secret is unrecoverable once lost: undo the create.
      await ctx.accessApi("DELETE", `${a}/apps/${created.id}`).then(
        () => delete state.pendingAccessAppId,
        () => {
          (e as Error).message +=
            `; rollback failed: DELETE of Access app ${created.id} also failed, delete it in Zero Trust > Access > Applications`;
        },
      );
      throw interrupted ? Object.assign(e as Error, { exitCode: 130 }) : e;
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}

export const access: Step = {
  name: "access",
  async check(state, ctx) {
    // From state alone under --upgrade, or when no OA_ACCESS_TOKEN can re-check.
    const noToken = !ctx.deps.env.OA_ACCESS_TOKEN;
    // Only for the same install: a changed host or account needs the full path.
    const same =
      ctx.prev?.appHost === ctx.opts.appHost &&
      ctx.prev?.accountId === state.accountId;
    if (
      (ctx.opts.upgrade || noToken) &&
      same &&
      state.accessAppId &&
      state.accessClientId &&
      state.teamDomain
    ) {
      if (!(await listSecrets(ctx)).has(ACCESS_SECRET)) return "todo";
      ctx.notes.push(
        ctx.opts.upgrade
          ? "verified from state only (--upgrade); rerun without --upgrade to reconcile Access"
          : "Access not re-verified: run `read -rs OA_ACCESS_TOKEN; export OA_ACCESS_TOKEN` to re-check",
      );
      return "done";
    }
    const l = await lookup(ctx, state.accountId ?? "").catch((e) => {
      if (status(e) !== 403) throw e;
      ctx.notes.push(
        e.teamDomain
          ? "team domain unknown: organizations 403; set OA_TEAM_DOMAIN or use an OA_ACCESS_TOKEN with Access: Organizations Read"
          : `this token cannot read Access (organizations 403, no app named ${ctx.opts.name} visible); set OA_ACCESS_TOKEN`,
      );
      return undefined;
    });
    if (!l) return "todo";
    const drift = !l.policy || !policyMatches(l.policy);
    const why = !l.domain
      ? "no Zero Trust organization"
      : !l.app
        ? `Access app ${ctx.opts.name} not found`
        : l.app.type !== "saas" || l.app.saas_app?.auth_type !== "oidc"
          ? `Access app ${ctx.opts.name} is not SaaS OIDC`
          : !linked(l.app, l.policy?.id)
            ? `Access app ${ctx.opts.name} not linked to policy "${POLICY_NAME}"`
            : !l.app.saas_app.client_id
              ? `Access app ${ctx.opts.name} has no client_id`
              : !l.have.has(ACCESS_SECRET)
                ? `${ACCESS_SECRET} missing on the Worker`
                : drift && !ctx.opts.upgrade
                  ? `policy "${POLICY_NAME}" drifted`
                  : undefined;
    if (why) {
      ctx.notes.push(why);
      return "todo";
    }
    if (drift)
      ctx.notes.push(
        `policy "${POLICY_NAME}" drifted; not reconciled (--upgrade), rerun without --upgrade to fix`,
      );
    record(state, ctx, l.domain as string, l.app);
    return "done";
  },
  async apply(state, ctx) {
    // Preflight: nothing is written until every check below has passed.
    const l = await lookupWithToken(ctx, state.accountId ?? "");
    if ("status" in l) return l;
    if (!l.domain)
      return AR(
        `No Zero Trust organization on this account: open ${ZERO_TRUST}, enable Zero Trust (free), then rerun.`,
        { url: ZERO_TRUST },
      );
    const where = `Zero Trust > Access > Applications > ${ctx.opts.name}`;
    let app = l.app;
    if (
      !ctx.opts.upgrade &&
      app &&
      app.id === state.pendingAccessAppId &&
      !l.have.has(ACCESS_SECRET) &&
      app.saas_app?.redirect_uris?.includes(callback(ctx))
    ) {
      // Ours, from an interrupted run, and its secret is lost: recreate it.
      await ctx.accessApi("DELETE", `${l.a}/apps/${app.id}`);
      delete state.pendingAccessAppId;
      app = undefined;
    }
    if (app) {
      // Never PUT an existing app: a full replace would drop dashboard edits.
      if (app.type !== "saas" || app.saas_app?.auth_type !== "oidc")
        return AR(
          `Access app ${ctx.opts.name} exists but is not a SaaS OIDC app. Rename or delete it (${where}), then rerun.`,
        );
      if (!linked(app, l.policy?.id))
        return AR(
          `Access app ${ctx.opts.name} is not linked to policy "${POLICY_NAME}". Attach it in ${where} > Policies, or delete the app, then rerun.`,
        );
      if (!app.saas_app.client_id)
        throw new Error(
          `Access app ${ctx.opts.name} has no saas_app.client_id`,
        );
      if (!l.have.has(ACCESS_SECRET))
        return AR(
          `${ACCESS_SECRET} is missing on the Worker and can't be recovered: the API returns the client secret only on create. Delete the Access app (${where}), then rerun.`,
        );
    }
    if (ctx.opts.upgrade) {
      // --upgrade never writes Access: no create, no policy POST or PUT.
      if (!app)
        return AR(
          `Access app ${ctx.opts.name} not found on account ${state.accountId}; --upgrade never creates it, run a full setup first (without --upgrade).`,
        );
      record(state, ctx, l.domain, app);
      return undefined;
    }
    // The policy is written only once the existing-app checks have passed.
    let policyId: string = l.policy?.id;
    if (!l.policy)
      policyId = (
        await ctx.accessApi<Obj>("POST", `${l.a}/policies`, POLICY_BODY)
      ).id;
    else if (!policyMatches(l.policy)) {
      const kept = Object.fromEntries(
        CARRY_OVER.filter((k) => l.policy[k] !== undefined).map((k) => [
          k,
          l.policy[k],
        ]),
      );
      await ctx.accessApi("PUT", `${l.a}/policies/${policyId}`, {
        ...kept,
        ...POLICY_BODY,
      });
    }
    if (app) record(state, ctx, l.domain, app);
    else await create(state, ctx, l.a, policyId, l.domain);
    return undefined;
  },
};
