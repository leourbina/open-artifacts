// users.restricted_sync (P3 T9): 1 while the user is in any restricted group,
// never for an org owner or admin (restrict_admin; sync skips them). One
// definition, recomputed wherever its inputs change: a restricted group added
// or removed (every member of that group) and a role change (that user).

/** The flag's value for the `users` row in scope. */
export const RESTRICTED_SYNC_CASE = `(case
    when users.role in ('owner', 'admin') then 0
    when exists (select 1 from directory_members dm join restricted_groups rg on rg.group_id = dm.group_id
      where dm.user_id = users.id) then 1
    else 0 end)`;

/** Recomputes the flag for every member of group ?1 (only rows that change). */
export const RESTRICTED_SYNC_FOR_GROUP = `update users set restricted_sync = ${RESTRICTED_SYNC_CASE}
  where id in (select user_id from directory_members where group_id = ?1)
    and restricted_sync <> ${RESTRICTED_SYNC_CASE}`;

/**
 * Recomputes the flag for user ?1, returning the new value only when it
 * changed (no row = unchanged), so the caller knows a cap was just raised.
 */
export const RESTRICTED_SYNC_FOR_USER = `update users set restricted_sync = ${RESTRICTED_SYNC_CASE}
  where id = ?1 and restricted_sync <> ${RESTRICTED_SYNC_CASE}
  returning restricted_sync as restrictedSync`;
