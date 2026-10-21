import type { MockOptions } from "@oa/shared/mocks";

export type HostedMockOptions = Exclude<
  NonNullable<MockOptions["hosted"]>,
  boolean
>;

const TOKENS: Record<string, HostedMockOptions> = {
  "1": {},
  access: { mode: "access" },
  "email-only": { providers: ["email"] },
  turnstile: { turnstile: true },
  unhealthy: { unhealthy: true },
  trial: { tier: "trial" },
  team: { tier: "team" },
  business: { tier: "business" },
  frozen: { directory: "frozen" },
  "sync-off": { directory: "off" },
};

/**
 * Mock-only: `?hosted=` turns on the hosted mocks. Comma tokens: 1 (defaults),
 * access, email-only, turnstile, unhealthy, trial, team, business, frozen,
 * sync-off. Absent: the self-hosted mocks.
 */
export const parseHostedParam = (
  raw: string | null,
): HostedMockOptions | undefined => {
  if (raw === null) return undefined;
  const out: HostedMockOptions = {};
  for (const t of raw.split(",")) Object.assign(out, TOKENS[t.trim()]);
  return out;
};
