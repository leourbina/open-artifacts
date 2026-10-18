import type { Ctx, Step } from "../step.ts";

/** Hosts lacking a zone, found by check and reported by apply. */
const missingFor = new WeakMap<Ctx, string[]>();

/** Candidate zones for a host, most specific first: a.b.c.com → a.b.c.com, b.c.com, c.com. */
export const apexCandidates = (host: string) => {
  const labels = host.split(".");
  return labels.slice(0, -1).map((_, i) => labels.slice(i).join("."));
};

async function zoneOf(ctx: Ctx, accountId: string, host: string) {
  for (const name of apexCandidates(host)) {
    const q = `/zones?name=${encodeURIComponent(name)}&account.id=${accountId}&status=active`;
    const zones = await ctx.api<{ name: string }[]>("GET", q);
    if (zones.length) return name;
  }
  return null;
}

async function missingHosts(ctx: Ctx, accountId: string) {
  const { appHost, contentHost } = ctx.opts;
  const missing: string[] = [];
  for (const h of [appHost, contentHost])
    if (!(await zoneOf(ctx, accountId, h))) missing.push(h);
  return missing;
}

/** A pure verification: `done` (skipped) when every prerequisite holds. */
export const prereqs: Step = {
  name: "prereqs",
  async check(state, ctx) {
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 22)
      throw new Error(`Node >= 22 required (found ${process.versions.node})`);
    if ((await ctx.deps.exec("pnpm", ["--version"])).code !== 0)
      throw new Error("pnpm not found on PATH");
    const who = JSON.parse(await ctx.wrangler(["whoami", "--json"])) as {
      accounts?: { id: string; name: string }[];
    };
    const accounts = who.accounts ?? [];
    if (!accounts.length)
      throw new Error(
        "`wrangler whoami` lists no accounts; run `wrangler login`",
      );
    let id =
      ctx.opts.accountId ??
      (accounts.length === 1 ? accounts[0].id : undefined);
    if (!id) {
      const list = accounts.map((a) => `${a.id} (${a.name})`).join(", ");
      if (ctx.opts.yes)
        throw new Error(`several accounts (${list}); pass --account-id`);
      id = await ctx.deps.prompt(`Cloudflare account id [${list}]:`);
    }
    if (!accounts.some((a) => a.id === id))
      throw new Error(`--account-id ${id} is not in \`wrangler whoami\``);
    state.accountId = id;
    const missing = await missingHosts(ctx, id);
    missingFor.set(ctx, missing);
    return missing.length ? "todo" : "done";
  },
  async apply(state, ctx) {
    const missing = missingFor.get(ctx) ?? [];
    return {
      status: "action_required",
      message: `not in any zone of account ${state.accountId}: ${missing.join(", ")}. Add the zone to this account, then rerun.`,
      data: { missing },
    };
  },
};
