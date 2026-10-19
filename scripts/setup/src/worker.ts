import type { Ctx } from "./step.ts";

/** Deployed vars compared when state is rebuilt (names only in messages). */
export const PINNED = [
  "APP_HOST",
  "CONTENT_HOST",
  "OWNER_EMAIL",
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_CLIENT_ID",
] as const;

type Settings = {
  bindings?: { type: string; name: string; text?: string }[];
};

/** The live Worker's bindings; undefined when no Worker exists (404). */
export async function workerBindings(ctx: Ctx, accountId: string) {
  const path = `/accounts/${accountId}/workers/scripts/${encodeURIComponent(ctx.opts.name)}/settings`;
  const settings = await ctx.api<Settings>("GET", path).catch((e) => {
    if ((e as { status?: number }).status === 404) return undefined;
    throw e;
  });
  return settings?.bindings;
}

/**
 * The live Worker's plain-text vars, from `GET .../workers/scripts/{name}/settings`.
 * Undefined when it was never deployed: no Worker (404), or a draft (made by a
 * secret put) carrying none of the PINNED vars.
 */
export async function deployedVars(
  ctx: Ctx,
  accountId: string,
): Promise<Map<string, string | undefined> | undefined> {
  const vars = new Map(
    ((await workerBindings(ctx, accountId)) ?? [])
      .filter((b) => b.type === "plain_text")
      .map((b) => [b.name, b.text]),
  );
  return PINNED.some((k) => vars.has(k)) ? vars : undefined;
}
