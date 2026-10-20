import { env } from "cloudflare:workers";
import type { Env } from "../src/env.js";

/** The Google client id the fake Google issuer and direct() agree on. */
export const CID = "cid.apps.googleusercontent.com";

/** A valid Ed25519 PKCS#8 private key (base64url), for broker-mode configs. */
export const TEST_BROKER_KEY =
  "MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f";

/** The test env with direct sign-in (Google direct transport and codes) on. */
export function direct(over: Partial<Env> = {}): Env {
  return {
    ...env,
    AUTH_PROVIDERS: "google,email",
    AUTH_DOMAINS: "a.com",
    AUTH_DOMAIN_JOIN: "member",
    GOOGLE_CLIENT_ID: CID,
    GOOGLE_CLIENT_SECRET: "s",
    INSTALL_ID: "inst-a",
    ...over,
  } as Env;
}

/** A code-only trial: domain codes on, Google off, Turnstile configured. */
export const trial = (over: Partial<Env> = {}): Env =>
  direct({
    AUTH_PROVIDERS: "email",
    EMAIL_CODE_DOMAIN: "on",
    TURNSTILE_SITE_KEY: "k",
    TURNSTILE_SECRET: "s",
    ...over,
  });
