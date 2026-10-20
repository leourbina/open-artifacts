import { GOOGLE_JWKS_URL, GOOGLE_TOKEN_URL } from "@oa/auth-core";
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { vi } from "vitest";
import { b64urlEncode } from "../../src/util/crypto.js";
import { CID } from "../auth-helpers.js";

/** Default claims of a valid ID token for install A (hd a.com). */
export const GOOGLE_BASE = {
  iss: "https://accounts.google.com",
  aud: CID,
  azp: CID,
  sub: "google-sub-1",
  email: "bob@a.com",
  email_verified: true,
  hd: "a.com",
} as const;

type CodeEntry = {
  challenge: string;
  claims: Record<string, unknown>;
  key?: CryptoKey;
};

/**
 * A fake Google behind a global fetch spy: the token endpoint (PKCE checked,
 * codes single use) and the JWKS. Exported for P5 and the broker tests.
 */
// One signing key per test isolate: the verifier caches Google's JWKS at
// module scope (as in production), so a new key per test would never match.
let signing:
  | Promise<{ kp: CryptoKeyPair; jwk: Record<string, unknown> }>
  | undefined;
const signingKey = () =>
  (signing ??= (async () => {
    const kp = await generateKeyPair("RS256", { extractable: true });
    return {
      kp,
      jwk: { ...(await exportJWK(kp.publicKey)), kid: "g1", alg: "RS256" },
    };
  })());

export async function fakeGoogle() {
  const { kp, jwk } = await signingKey();
  const codes = new Map<string, CodeEntry>();
  const tokenCalls: URLSearchParams[] = [];
  let tokenStatus = 200;

  const mint = (
    claims: Record<string, unknown>,
    o: { key?: CryptoKey; alg?: string } = {},
  ) => {
    const now = Math.floor(Date.now() / 1000);
    const body = Object.fromEntries(
      Object.entries({
        ...GOOGLE_BASE,
        iat: now,
        exp: now + 3600,
        ...claims,
      }).filter(([, v]) => v !== undefined),
    ) as JWTPayload;
    return new SignJWT(body)
      .setProtectedHeader({ alg: o.alg ?? "RS256", kid: "g1" })
      .sign(o.key ?? kp.privateKey);
  };

  const realFetch = globalThis.fetch;
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      if (req.url === GOOGLE_JWKS_URL) return Response.json({ keys: [jwk] });
      if (req.url === GOOGLE_TOKEN_URL && req.method === "POST") {
        const body = new URLSearchParams(await req.text());
        tokenCalls.push(body);
        if (tokenStatus !== 200)
          return Response.json(
            { error: "server_error" },
            { status: tokenStatus },
          );
        const code = body.get("code") ?? "";
        const entry = codes.get(code);
        codes.delete(code); // single use
        if (!entry)
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        const d = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(body.get("code_verifier") ?? ""),
        );
        if (b64urlEncode(new Uint8Array(d)) !== entry.challenge)
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({
          id_token: await mint(entry.claims, { key: entry.key }),
          access_token: "at",
          token_type: "Bearer",
        });
      }
      return realFetch(input, init);
    });

  return {
    mint,
    tokenCalls,
    /** Registers a code that redeems (with the matching verifier) to these claims. */
    issueCode(
      claims: Record<string, unknown>,
      challenge: string,
      key?: CryptoKey,
    ): string {
      const code = `code-${crypto.randomUUID()}`;
      codes.set(code, { challenge, claims, key });
      return code;
    },
    setTokenStatus(s: number) {
      tokenStatus = s;
    },
    restore: () => spy.mockRestore(),
  };
}
export type FakeGoogle = Awaited<ReturnType<typeof fakeGoogle>>;
