// Fixture for authz-lint.test.ts: every line here must be reported.
declare const user: { role: string };
declare const a: { ownerId: string };
declare const me: string;
declare const TEAM_ROLES: string[];
declare function requireAccess(...x: unknown[]): void;
declare const env: unknown, c: unknown, id: string;
export const x = user.role === "admin";
export const y = a.ownerId !== me;
export const z = TEAM_ROLES;
requireAccess(env, c, id, "owner");
