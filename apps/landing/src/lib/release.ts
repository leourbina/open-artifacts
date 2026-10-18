import { toolsAreFallback } from "./tools";

// Stand-ins that must not reach a production release. Platform's release gate
// blocks the deploy while dist/ contains "TODO" or "OA-UNRELEASED".
export const FALLBACKS = {
  B14: { label: "B14 tool list", todo: "TODO(B14): fallback tool list" },
  D6: { label: "D6 wordmark", todo: "TODO(D6): text wordmark" },
} as const;

export type FallbackId = keyof typeof FALLBACKS;

export const UNRELEASED = "OA-UNRELEASED";

// Automatic: off once the server's tool manifest exists.
export const b14Active = toolsAreFallback;
// Manual: set to false when D6 merges and the logo comes from @oa/ui/brand.
export const d6Active = true;

// The B14 marker for pages that show the tool list.
export const toolListFallbacks: FallbackId[] = b14Active ? ["B14"] : [];
