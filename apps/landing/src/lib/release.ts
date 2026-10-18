import { toolsAreFallback } from "./tools";

// Stand-ins that must not reach a production release. Platform's release gate
// blocks the deploy while dist/ contains "TODO" or "OA-UNRELEASED".
export const FALLBACKS = {
  B14: { label: "B14 tool list", todo: "TODO(B14): fallback tool list" },
} as const;

export type FallbackId = keyof typeof FALLBACKS;

export const UNRELEASED = "OA-UNRELEASED";

// Automatic: off once the server's tool manifest exists.
export const b14Active = toolsAreFallback;

// The B14 marker for pages that show the tool list.
export const toolListFallbacks: FallbackId[] = b14Active ? ["B14"] : [];
