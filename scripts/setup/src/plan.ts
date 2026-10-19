import type { State } from "./state.ts";
import type { Ctx } from "./step.ts";

export type Plan = "free" | "paid" | "unknown";
export type Warning = { code: string; plan: Plan; message: string };

export const DASH_PLANS =
  "https://dash.cloudflare.com/?to=/:account/workers/plans";

/** Workers rate plans that include Workers Paid (developers.cloudflare.com/tenant/reference/subscriptions). */
const PAID_IDS = new Set([
  "WORKERS_PAID",
  "PARTNERS_WORKERS_SS",
  "PARTNERS_WORKERS_ENT",
]);
/** Subscription states that are live; Cancelled, Failed, Expired, AwaitingPayment are not. */
const LIVE = new Set(["Paid", "Provisioned", "Trial"]);

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * The Workers plan, read-only: `GET /accounts/{id}/subscriptions`, Paid when an
 * item's `rate_plan.id` is a Workers Paid plan (WORKERS_PAID) and its `state`
 * is live. Needs Billing Read (the `wrangler login` token lacks it): any error
 * or a result of the wrong shape is `unknown`, never a guess.
 */
export async function detectPlan(ctx: Ctx, accountId: string): Promise<Plan> {
  let subs: unknown;
  try {
    subs = await ctx.api("GET", `/accounts/${accountId}/subscriptions`);
  } catch {
    return "unknown";
  }
  if (
    !Array.isArray(subs) ||
    !subs.every(
      (s) => isObj(s) && (s.rate_plan === undefined || isObj(s.rate_plan)),
    )
  )
    return "unknown";
  const paid = subs.some((s) => {
    const id = (s.rate_plan as { id?: unknown } | undefined)?.id;
    return (
      typeof id === "string" &&
      PAID_IDS.has(id.toUpperCase()) &&
      (s.state === undefined || LIVE.has(String(s.state)))
    );
  });
  return paid ? "paid" : "free";
}

/** What Workers Free means for this app; none on Paid. */
export function warnings(plan: Plan): Warning[] {
  if (plan === "paid") return [];
  const w = (code: string, message: string) => ({ code, plan, message });
  return [
    ...(plan === "unknown"
      ? [
          w(
            "plan-unknown",
            "Setup could not read the Workers plan (that needs Billing Read, which the wrangler login token does not have), so it assumes Workers Free limits.",
          ),
        ]
      : []),
    w(
      "cpu-limit",
      "Workers Free allows 10 ms of CPU time per request, so large publishes can fail.",
    ),
    w(
      "kv-writes",
      "Workers Free allows 1,000 KV writes per day per account. Each agent sign-in (client registration and consent) and each token refresh writes KV, so many agents can reach that limit.",
    ),
    w(
      "no-email",
      "Workers Free has no outbound email: Email Sending to any recipient needs Workers Paid, so team invites can't be emailed.",
    ),
    w(
      "individual-use",
      `On Workers Free this install is for individual use. For a team, upgrade to Workers Paid: ${DASH_PLANS}`,
    ),
  ];
}

const yes = (a: string) => /^y(es)?$/i.test(a);

/**
 * "Just you, or a team?", decided once the plan is known: flag, then saved
 * state, then the question; solo when setup can't ask. Team on Free (or
 * unknown) needs a confirmation, and its email stays off without --yes-paid.
 */
export async function decideTeam(state: State, ctx: Ctx, plan: Plan) {
  const o = ctx.opts;
  let team = o.teamChoice;
  if (team === undefined && o.interactive && !o.check) {
    const q =
      plan === "paid"
        ? "Workers Paid detected. Just you, or a team? [solo/team] (team adds email invites):"
        : "Just you, or a team? [solo/team] (email invites need Workers Paid):";
    team = /^t(eam)?$/i.test(await ctx.deps.prompt(q));
    if (team && plan !== "paid")
      team = yes(
        await ctx.deps.prompt(
          `This account looks like Workers Free (plan: ${plan}), which is for individual use; invite email stays off unless you rerun with --yes-paid. Set up a team anyway? [y/N]`,
        ),
      );
  }
  team ??= false;
  const email =
    team &&
    !o.noEmail &&
    (plan === "paid" || o.yesPaid || state.email === true);
  if (team && !email && !o.noEmail)
    ctx.notes.push(
      `email off: Workers Paid not detected, so invites can't be sent. If the account is on Workers Paid (${DASH_PLANS}), rerun with --team --yes-paid`,
    );
  o.team = team;
  o.email = email;
  if (!team) o.emailDomain = undefined;
  Object.assign(state, { plan, team, email, emailDomain: o.emailDomain });
}
