import {
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_TOKEN_URL,
  GoogleTokenError,
  verifyGoogleIdToken,
} from "@oa/auth-core";
import { AUTH } from "@oa/shared";
import type { Env } from "../../env.js";
import { ApiError, appOrigin } from "../../http/errors.js";
import { type AuthConfig, authConfig } from "../config.js";
import { fail } from "../oidc.js";
import type { OidcProvider, VerifiedIdentity } from "./types.js";

// Sign in with Google. The install verifies the ID token itself (signature,
// iss, aud, azp, exp, its own nonce, email_verified, hd in AUTH_DOMAINS),
// whichever transport fetched it. Direct transport: this install holds its
// own Google client secret (self-hosted, or a dedicated client). The hosted
// broker transport arrives with the auth broker (P2 T11).

const redirectUri = (env: Env) => `${appOrigin(env)}${AUTH.callbackGoogle}`;

/** The Google config for the direct transport, or 404 (sign-in not offered). */
function directConfig(env: Env): {
  google: NonNullable<AuthConfig["google"]>;
  secret: string;
  domains: readonly string[];
} {
  const cfg = authConfig(env);
  const google = cfg.google;
  if (!google || google.transport.kind !== "direct")
    throw new ApiError("not_found", "Not found");
  return { google, secret: google.transport.secret, domains: cfg.domains };
}

export const googleProvider: OidcProvider = {
  id: "google",
  callbackPath: AUTH.callbackGoogle,

  authorizeUrl(env, a) {
    const { google, domains } = directConfig(env);
    const u = new URL(GOOGLE_AUTHORIZE_URL);
    u.search = new URLSearchParams({
      client_id: google.clientId,
      redirect_uri: redirectUri(env),
      response_type: "code",
      scope: "openid email profile",
      state: a.state,
      nonce: a.nonce,
      code_challenge: a.challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
      // A hint for the account chooser only; the hd claim is what's checked.
      hd: domains[0] as string,
    }).toString();
    return u.toString();
  },

  async redeem(env, a): Promise<VerifiedIdentity> {
    const { google, secret, domains } = directConfig(env);
    let idToken: unknown;
    try {
      const res = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: a.code,
          redirect_uri: redirectUri(env),
          client_id: google.clientId,
          client_secret: secret,
          code_verifier: a.verifier,
        }),
        redirect: "manual",
      });
      if (!res.ok) {
        await res.body?.cancel();
        return fail(`token_http_${res.status}`);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return fail("token_bad_json");
      }
      idToken = (body as { id_token?: unknown } | null)?.id_token;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      return fail("token_fetch");
    }
    if (typeof idToken !== "string") return fail("no_id_token");
    try {
      const id = await verifyGoogleIdToken(
        { clientId: google.clientId, domains },
        idToken,
        a.nonce,
      );
      return {
        provider: "google",
        subject: id.sub,
        email: id.email,
        name: id.name,
        tenant: id.hd,
      };
    } catch (e) {
      if (e instanceof GoogleTokenError) return fail(e.stage);
      return fail("jwt_verify");
    }
  },
};
