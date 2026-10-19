import {
  type Member,
  type MemberInvite,
  type MemberInviteResult,
  type MemberPatch,
  newId,
  type Settings,
  type SettingsPatch,
} from "@oa/shared";
import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { normEmail } from "../db/email.js";
import {
  artifacts,
  reservedArtifacts,
  settings,
  shares,
  tokens,
  uploads,
  users,
  versions,
} from "../db/schema.js";
import { stmt } from "../db/stmt.js";
import { emailEnabled, sendEmail } from "../email/send.js";
import { inviteEmail } from "../email/templates.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { revokeAllGrants } from "../mcp/oauth-api.js";
import { closeRuntimeSockets, MAX_CLOSE } from "../runtime/revoke.js";
import { toMember } from "./users.js";

export async function listMembers(env: Env): Promise<Member[]> {
  const rows = await getDb(env)
    .select()
    .from(users)
    .orderBy(asc(users.createdAt), asc(users.id));
  return rows.map(toMember);
}

/**
 * Pre-creates the user row, then emails the invitee (best effort).
 * 400 on an invalid (non-ASCII) email, 409 if it exists.
 */
export async function inviteMember(
  env: Env,
  inviter: Member,
  input: MemberInvite,
): Promise<MemberInviteResult> {
  const email = normEmail(input.email);
  if (!email) throw new ApiError("bad_request", "Invalid email");
  const [row] = await getDb(env)
    .insert(users)
    .values({
      id: newId(),
      email,
      name: "",
      role: input.role,
      createdAt: Date.now(),
    })
    .onConflictDoNothing({ target: users.email })
    .returning();
  if (!row) throw new ApiError("conflict", "Already a member");
  let emailed = false;
  if (emailEnabled(env)) {
    const instance = (await getSettings(env).catch(() => DEFAULT_SETTINGS))
      .name;
    emailed = await sendEmail(env, inviter.id, email, () =>
      inviteEmail({
        inviter: inviter.name || inviter.email,
        instance,
        recipient: email,
        appHost: env.APP_HOST,
      }),
    );
  }
  return { ...toMember(row), emailed };
}

async function getRow(env: Env, id: string) {
  const row = (
    await getDb(env).select().from(users).where(eq(users.id, id)).limit(1)
  )[0];
  if (!row) throw new ApiError("not_found", "Not found");
  return row;
}

export async function patchMember(
  env: Env,
  id: string,
  patch: MemberPatch,
): Promise<Member> {
  const row = await getRow(env, id);
  if (row.role === "owner")
    throw new ApiError("bad_request", "The owner cannot be demoted");
  const db = getDb(env);
  const [out] = await db
    .update(users)
    .set({ role: patch.role })
    .where(eq(users.id, id))
    .returning();
  if (!out) throw new ApiError("not_found", "Not found");
  // Guests can't connect agents: a demotion revokes their PATs and OAuth grants.
  // (MemberPatch allows only admin|member today; this guards a wider contract.)
  const role: string = patch.role;
  if (role === "guest") {
    await db
      .update(tokens)
      .set({ revokedAt: Date.now() })
      .where(and(eq(tokens.userId, id), isNull(tokens.revokedAt)));
    await revokeAllGrants(env, id);
  }
  return toMember(out);
}

/**
 * Removes the user row in one D1 batch. Their artifacts (and every other row
 * that references them) are reassigned to the instance owner; their tokens are
 * deleted (tokens.user_id has no cascade, so revoked rows would block the
 * delete). Shares addressed to their email are kept.
 */
export async function removeMember(
  env: Env,
  id: string,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const row = await getRow(env, id);
  if (row.role === "owner")
    throw new ApiError("bad_request", "The owner cannot be removed");
  const db = getDb(env);
  const owner = (
    await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "owner"))
      .orderBy(asc(users.createdAt), asc(users.id))
      .limit(1)
  )[0];
  if (!owner) throw new ApiError("bad_request", "No owner to reassign to");
  // OAuth grants live in KV, outside the batch: revoke them first.
  await revokeAllGrants(env, id);
  const to = owner.id;
  await db.batch([
    db.update(artifacts).set({ ownerId: to }).where(eq(artifacts.ownerId, id)),
    db
      .update(versions)
      .set({ createdBy: to })
      .where(eq(versions.createdBy, id)),
    db.update(shares).set({ createdBy: to }).where(eq(shares.createdBy, id)),
    db.update(uploads).set({ userId: to }).where(eq(uploads.userId, id)),
    db
      .update(reservedArtifacts)
      .set({ userId: to })
      .where(eq(reservedArtifacts.userId, id)),
    db.delete(tokens).where(eq(tokens.userId, id)),
    db.delete(users).where(eq(users.id, id)),
  ]);
  // Live sockets the member opened via shares stay open otherwise (best effort, capped).
  const shared = await db
    .select({ id: shares.artifactId })
    .from(shares)
    .where(eq(shares.email, row.email))
    .limit(MAX_CLOSE);
  await closeRuntimeSockets(
    env,
    shared.map((r) => r.id),
    "member removed",
    ctx,
  );
}

const DEFAULT_SETTINGS: Settings = {
  name: "Open Artifacts",
  defaultVisibility: "private",
};
const KEY = { name: "name", defaultVisibility: "default_visibility" } as const;

const SETTINGS_ALL = "select key, value from settings";

/** Every publish and /me: one prepared D1 statement. */
export async function getSettings(env: Env): Promise<Settings> {
  const { results: rows } = await stmt(env.DB, SETTINGS_ALL).all<{
    key: string;
    value: string;
  }>();
  const kv = new Map(rows.map((r) => [r.key, r.value]));
  const name = kv.get(KEY.name);
  const vis = kv.get(KEY.defaultVisibility);
  return {
    name: name && name.length <= 80 ? name : DEFAULT_SETTINGS.name,
    defaultVisibility:
      vis === "private" || vis === "team"
        ? vis
        : DEFAULT_SETTINGS.defaultVisibility,
  };
}

export async function patchSettings(
  env: Env,
  patch: SettingsPatch,
): Promise<Settings> {
  const db = getDb(env);
  const writes = (Object.keys(KEY) as (keyof typeof KEY)[])
    .filter((k) => patch[k] !== undefined)
    .map((k) =>
      db
        .insert(settings)
        .values({ key: KEY[k], value: String(patch[k]) })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: String(patch[k]) },
        }),
    );
  const [first, ...rest] = writes;
  if (first) await db.batch([first, ...rest]);
  return getSettings(env);
}
