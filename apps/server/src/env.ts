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
  // vars
  APP_HOST: string;
  CONTENT_HOST: string;
  OWNER_EMAIL: string;
  ENVIRONMENT: "dev" | "production";
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_CLIENT_ID: string;
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
