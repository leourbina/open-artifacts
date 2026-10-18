import type { ArtifactRuntime } from "./runtime/artifact-runtime.js";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  OAUTH_KV: KVNamespace;
  ARTIFACT_RUNTIME: DurableObjectNamespace<ArtifactRuntime>;
  ASSETS: Fetcher;
  RL_ANON: RateLimit;
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
}
