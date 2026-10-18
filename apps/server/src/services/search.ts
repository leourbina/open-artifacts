import type { Env } from "../env.js";

/** Indexes a version's text for search. No-op until B8. */
export async function indexVersion(
  _env: Env,
  _artifactId: string,
  _version: number,
): Promise<void> {}
