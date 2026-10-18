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
const callback = (ctx: Ctx) => `https://${ctx.opts.appHost}/auth/callback`;
const linked = (app: Obj, policyId?: string) =>
  Boolean(policyId) && app.policies?.some((p: Obj) => p.id === policyId);

async function lookup(ctx: Ctx, accountId: string) {
  const a = `/accounts/${accountId}/access`;
  // A 404 or a null result both mean "no Zero Trust organization".
  const org = await ctx
    .accessApi<{ auth_domain?: string } | null>("GET", `${a}/organizations`)
    .catch((e) => {
      if (status(e) === 404) return null;
      throw e;
    });
  const policy = (await ctx.accessApi.all<Obj>(`${a}/policies`)).find(
    (p) => p.name === POLICY_NAME,
  );
  const app = (await ctx.accessApi.all<Obj>(`${a}/apps`)).find(
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
  delete state.pendingAccessAppId;
  writeConfig(state, ctx);
  if (!app.saas_app.redirect_uris?.includes(callback(ctx)))
    ctx.notes.push(
      `warning: Access app ${app.name} redirect_uris lack ${callback(ctx)}; add it in the dashboard`,
    );
}

/** Lookup with OA_ACCESS_TOKEN or the wrangler token; on 403, ask once (memory only). */
async function lookupWithToken(ctx: Ctx, accountId: string) {
  const denied = AR(
    "This token cannot read Access. Create one (Access: Apps and Policies Edit; Access: Organizations Read; Zone: DNS Read) and set OA_ACCESS_TOKEN, or rerun interactively and paste it (kept in memory only).",
    { url: TOKEN_URL },
  );
  try {
    return await lookup(ctx, accountId);
  } catch (e) {
    if (status(e) !== 403) throw e;
    if (!ctx.opts.interactive) return denied;
    const q = `Paste an OA_ACCESS_TOKEN (input hidden; create one at ${TOKEN_URL}):`;
    const token = await ctx.deps.prompt(q, { secret: true });
    if (!token) return denied;
    ctx.accessApi = makeApi(ctx.deps, ctx.wrangler, token);
    try {
      return await lookup(ctx, accountId);
    } catch (e2) {
      if (status(e2) === 403) return denied;
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
    if (
      ctx.opts.upgrade &&
      state.accessAppId &&
      state.accessClientId &&
      state.teamDomain
    ) {
      if (!(await listSecrets(ctx)).has(ACCESS_SECRET)) return "todo";
      ctx.notes.push(
        "verified from state only (--upgrade); rerun without --upgrade to reconcile Access",
      );
      return "done";
    }
    const l = await lookup(ctx, state.accountId ?? "").catch((e) => {
      if (status(e) === 403) return undefined;
      throw e;
    });
    if (
      !l?.domain ||
      !l.policy ||
      !policyMatches(l.policy) ||
      !l.app ||
      l.app.type !== "saas" ||
      l.app.saas_app?.auth_type !== "oidc" ||
      !linked(l.app, l.policy.id) ||
      !l.app.saas_app.client_id ||
      !l.have.has(ACCESS_SECRET)
    )
      return "todo";
    record(state, ctx, l.domain, l.app);
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
