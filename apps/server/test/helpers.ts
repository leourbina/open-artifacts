import type { Role } from "@oa/shared";

// Inserts the user and mints a session via the B4 session helper (lands with B4).
export async function login(
  _email: string,
  _role?: Role,
): Promise<{ cookie: string; userId: string }> {
  throw new Error("B4 pending");
}
