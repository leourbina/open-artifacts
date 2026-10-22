// Sealed gates. NOT exported from the package index and not reachable from
// any options object: only a code change here opens them. Tests override
// them with vi.mock("../src/internal/gates.js").

/** Not a key. create refuses while RELEASE_PUBKEY[env] holds this. */
export const RELEASE_PUBKEY_PLACEHOLDER =
  "PLACEHOLDER-not-a-key-T3b-sets-the-release-signing-public-key";

/**
 * Prod creates stay refused (ProdLocked) until the T3b release-record writer
 * exists. TODO(T3b): flip to true in the same change that ships the writer.
 */
export const PROD_UNLOCKED: boolean = false;

/** Live envs always use the dispatch namespace; the account target is tests only. */
export const ALLOW_ACCOUNT_TARGET: boolean = false;

/**
 * The release workflow's Ed25519 public key per env: base64url of the raw
 * 32 bytes (JWK `x`). TODO(T3b): set the real keys, one per env (they must
 * differ); the private keys live only in the release workflow's secrets.
 */
export const RELEASE_PUBKEY: Readonly<Record<"staging" | "prod", string>> =
  Object.freeze({
    staging: RELEASE_PUBKEY_PLACEHOLDER,
    prod: RELEASE_PUBKEY_PLACEHOLDER,
  });
