import type { Env } from "../../env.js";
import type { ProviderId } from "../config.js";

/** What a redirect provider vouches for, after every check passed. */
export type VerifiedIdentity = {
  provider: ProviderId;
  /** The provider's stable subject (Access `sub`, Google `sub`). */
  subject: string;
  email: string;
  name: string | null;
  /** Verified tenant (Google `hd`), or null when the provider has none. */
  tenant: string | null;
};

/**
 * A redirect (OIDC) sign-in provider. oidc.ts owns the state cookie, PKCE
 * and nonce; a provider builds its authorize URL and redeems the code.
 */
export interface OidcProvider {
  id: ProviderId;
  /** The path its authorization response comes back to. */
  callbackPath: string;
  authorizeUrl(
    env: Env,
    a: { state: string; nonce: string; challenge: string },
  ): Promise<string> | string;
  /**
   * Exchanges the code and verifies the result (nonce included). Throws
   * ApiError("unauthorized") after logOidcFail(stage) on any failure.
   */
  redeem(
    env: Env,
    a: { code: string; verifier: string; nonce: string },
  ): Promise<VerifiedIdentity>;
}
