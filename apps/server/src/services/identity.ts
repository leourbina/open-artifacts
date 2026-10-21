import { inDomains, normalizeEmail } from "@oa/auth-core";
import type { Member, Role } from "@oa/shared";
import type { AuthConfig } from "../auth/config.js";
import { isGuestRole, promotedRole } from "../auth/policy.js";
import type { VerifiedIdentity } from "../auth/providers/types.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { googleLinkStmts, toMember } from "./users.js";

// Admission and account linking for direct sign-in (P2). identities
// (provider, subject) is the only link; email links an existing ACTIVE row at
// most once, never a removed or suspended one.

export type AdmitResult =
  | { ok: true; user: Member }
  | {
      ok: false;
      reason: "tenant" | "identity_conflict" | "removed" | "no_access";
    };

type UserRow = {
  id: string;
  email: string;
  name: string;
  displayName: string | null;
  role: string;
  lastSeenAt: number | null;
  status: string;
};

const USER_COLS =
  "u.id, u.email, u.name, u.display_name as displayName, u.role, u.last_seen_at as lastSeenAt, u.status";

const BY_SUBJECT = `select ${USER_COLS} from identities i join users u on u.id = i.user_id
  where i.provider = ?1 and i.subject = ?2 limit 1`;
const BY_EMAIL = `select ${USER_COLS}, (select subject from identities i where i.user_id = u.id and i.provider = 'google') as subject
  from users u where u.email = ?1 limit 1`;

const member = (r: UserRow) => toMember(r as Parameters<typeof toMember>[0]);

const logDrift = () =>
  console.warn(JSON.stringify({ evt: "email_drift", outcome: "kept" }));

/** Name, last-seen, guest promotion (hd verified) and owner role on sign-in. */
async function touch(
  env: Env,
  row: UserRow,
  id: VerifiedIdentity,
  now: number,
): Promise<Member> {
  const owner = normalizeEmail(env.OWNER_EMAIL ?? "");
  const role =
    owner && row.email === owner ? "owner" : promotedRole(row.role as Role);
  const out = await stmt(
    env.DB,
    `update users set last_seen_at = ?1, name = coalesce(?2, name), role = ?3 where id = ?4
     returning id, email, name, display_name as displayName, role, last_seen_at as lastSeenAt, status`,
  )
    .bind(now, id.name, role, row.id)
    .first<UserRow>();
  return member(out ?? { ...row, role });
}

/** Moves a linked user to their new verified address when nobody else has it. */
async function followDrift(
  env: Env,
  row: UserRow,
  email: string,
): Promise<UserRow> {
  if (email === row.email) return row;
  try {
    const out = await stmt(
      env.DB,
      `update users set email = ?1 where id = ?2 and not exists (select 1 from users where email = ?1)
       returning id, email, name, display_name as displayName, role, last_seen_at as lastSeenAt, status`,
    )
      .bind(email, row.id)
      .first<UserRow>();
    if (out) return out;
  } catch {
    // A concurrent insert took the address: keep the old one.
  }
  logDrift();
  return row;
}

/**
 * Admits a verified Google identity:
 * 1. The tenant (hd) must still be a verified domain.
 * 2. Linked (provider, subject): that user, unless not active (removed);
 *    follow email drift when the new address is free.
 * 3. Unlinked: an existing row with the email must be active (else removed)
 *    and have no other Google link (else identity_conflict); a new row needs
 *    join = member or OWNER_EMAIL (else no_access). Created and linked in one
 *    race-safe batch (googleLinkStmts).
 * A guest promoted to member here is safe: hd proves domain membership.
 */
export async function admit(
  env: Env,
  cfg: AuthConfig,
  id: VerifiedIdentity,
  now = Date.now(),
): Promise<AdmitResult> {
  if (!inDomains(cfg.domains, id.tenant))
    return { ok: false, reason: "tenant" };
  const email = normalizeEmail(id.email);
  if (!email) return { ok: false, reason: "no_access" };

  const linked = await stmt(env.DB, BY_SUBJECT)
    .bind(id.provider, id.subject)
    .first<UserRow>();
  if (linked) {
    if (linked.status !== "active") return { ok: false, reason: "removed" };
    return {
      ok: true,
      user: await touch(env, await followDrift(env, linked, email), id, now),
    };
  }

  const existing = await stmt(env.DB, BY_EMAIL)
    .bind(email)
    .first<UserRow & { subject: string | null }>();
  if (existing && existing.status !== "active")
    return { ok: false, reason: "removed" };
  if (existing?.subject) return { ok: false, reason: "identity_conflict" };
  const isOwner = email === normalizeEmail(env.OWNER_EMAIL ?? "");
  if (!existing && !isOwner && cfg.domainJoin !== "member")
    return { ok: false, reason: "no_access" };

  const results = await env.DB.batch<UserRow & { subject: string | null }>(
    googleLinkStmts(env, {
      email,
      name: id.name,
      role: isOwner ? "owner" : "member",
      subject: id.subject,
      tenant: id.tenant as string,
      now,
    }),
  );
  const row = results[2]?.results[0];
  if (!row) return { ok: false, reason: "no_access" };
  if (row.status !== "active") return { ok: false, reason: "removed" };
  if (row.subject !== id.subject)
    return { ok: false, reason: "identity_conflict" };
  return { ok: true, user: await touch(env, row, id, now) };
}

export type CodeEligibility =
  | { kind: "member"; userId: string | null; role: Role }
  | { kind: "guest"; userId: string | null }
  | { kind: "none" };

const ELIGIBILITY = `select u.id, u.role, u.status,
    exists (select 1 from identities i where i.user_id = u.id) as linked
  from users u where u.email = ?1 limit 1`;
const SHARED = "select 1 as x from shares where email = ?1 limit 1";

/**
 * Who may get an emailed code (no writes; checked at request and at verify):
 * - never a user with a Google link, nor a removed or suspended row;
 * - in a verified domain: only while domain codes are on (trial, Google
 *   off): an existing row keeps its role, a new address joins as member if
 *   join = member;
 * - outside the domains: only invited guests (a guest row, or a share and no
 *   row); owner, admin and member rows there never sign in by code.
 */
export async function codeEligibility(
  env: Env,
  cfg: AuthConfig,
  rawEmail: string,
): Promise<CodeEligibility> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { kind: "none" };
  const row = await stmt(env.DB, ELIGIBILITY)
    .bind(email)
    .first<{ id: string; role: Role; status: string; linked: number }>();
  if (row && (row.status !== "active" || row.linked)) return { kind: "none" };
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (inDomains(cfg.domains, domain)) {
    if (!cfg.domainCodes) return { kind: "none" };
    if (row) return { kind: "member", userId: row.id, role: row.role };
    return cfg.domainJoin === "member"
      ? { kind: "member", userId: null, role: "member" }
      : { kind: "none" };
  }
  if (row)
    return isGuestRole(row.role)
      ? { kind: "guest", userId: row.id }
      : { kind: "none" };
  const shared = await stmt(env.DB, SHARED).bind(email).first();
  return shared ? { kind: "guest", userId: null } : { kind: "none" };
}

/**
 * Admin action: removes a member's Google link so their next Google sign-in
 * links afresh (clears an identity_conflict). Never the owner's link; 404
 * when there is none. Ends the member's sessions.
 */
export async function resetIdentity(
  env: Env,
  _actor: Member,
  userId: string,
): Promise<void> {
  const [del] = await env.DB.batch([
    stmt(
      env.DB,
      `delete from identities where provider = 'google'
       and user_id = (select id from users where id = ?1 and role <> 'owner') returning 1`,
    ).bind(userId),
  ]);
  if (!del?.results.length) throw new ApiError("not_found", "Not found");
  await stmt(
    env.DB,
    "update users set session_epoch = session_epoch + 1 where id = ?1",
  )
    .bind(userId)
    .run();
}
