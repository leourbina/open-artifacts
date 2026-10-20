import type { ArtifactRuntime } from "./runtime/do.js";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  OAUTH_KV: KVNamespace;
  ARTIFACT_RUNTIME: DurableObjectNamespace<ArtifactRuntime>;
  ASSETS: Fetcher;
  /** Anonymous-write limiter (per IP); unbound in the test pool. */
  RL_ANON?: RateLimit;
  /** Browser Run, for server-side thumbnails (services/thumbs.ts); optional. */
  BROWSER?: Fetcher;
  /** Optional Email Service send binding; invite/share emails are off without it. */
  EMAIL?: SendEmail;
  /**
   * "on" enables server thumbnails (with BROWSER bound); anything else, unset
   * included, is off. Setup sets it from the plan (Paid): a Free account's
   * alarm CPU (10 ms) can't afford a capture.
   */
  SERVER_THUMBNAILS?: string;
  /**
   * The Workers plan: "paid", else free (unset or anything else; planOf).
   * Sets the data-doc limit and the /mcp body cap. Setup sets it from the
   * detected plan.
   */
  PLAN?: string;
  /** "off" (any case) makes /skill.md 404 and drops the skill resource; public otherwise. */
  SKILL_MD?: string;
  /**
   * An artifact id. Signed-out visitors at "/" get a 302 to its chromeless
   * viewer when it is live and public; unset, empty, invalid, private,
   * missing or deleted leaves "/" unchanged.
   */
  PUBLIC_HOME?: string;
  /**
   * Anonymous writes per IP per artifact per minute, enforced in the DO
   * (anonWritesPerMin: 1..600, default LIMITS.anonWritesPerMinPerIp). The
   * RL_ANON binding's own per-IP limit (wrangler `ratelimits`) applies first.
   */
  ANON_WRITES_PER_MIN?: string;
  /**
   * Per-doc data limit in bytes (dataLimits; empty or unset: the plan's
   * default). Clamped to 256 KB on Free, 1920 KB on Paid.
   */
  DATA_DOC_BYTES?: string;
  /**
   * Data/storage writes per artifact per UTC day (dataLimits; empty or unset:
   * 10,000). Clamped to 10,000 on Free, 1,000,000 on Paid.
   */
  DATA_DAILY_WRITES?: string;
  // vars
  APP_HOST: string;
  CONTENT_HOST: string;
  OWNER_EMAIL: string;
  ENVIRONMENT: "dev" | "production";
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_CLIENT_ID: string;
  /**
   * Space-separated https origins allowed to frame /a/:id/full (and the
   * content host beneath it); unset/empty = none. Validated in http/embed.ts.
   */
  EMBED_ORIGINS?: string;
  /**
   * "1" keeps EMBED_ORIGINS entries that are same-site with APP_HOST (they
   * get Lax cookies in the frame); anything else drops them. Set it only once
   * the client embed mode is deployed.
   */
  EMBED_ALLOW_SAME_SITE?: string;
  /** Sender for invite/share emails (an onboarded Email Service domain). */
  EMAIL_FROM?: string;
  // secrets
  ACCESS_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  CONTENT_SIGNING_KEY: string;
  ANALYTICS_TOKEN?: string;
  CF_ACCOUNT_ID: string;
  /** This Worker's script name (filters CPU analytics); unset -> no CPU metrics. */
  WORKER_NAME?: string;
  /** OAUTH_KV's namespace id (filters KV analytics); unset -> no kv_writes. */
  OAUTH_KV_ID?: string;
}
