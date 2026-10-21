// Install-to-broker request signing (hosted Google transport). Each install
// holds an Ed25519 private key (PKCS#8, base64url); the broker's registry
// holds only public keys (raw 32 bytes, base64url) and their key ids.

const b64 = {
  enc(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(s: string): Uint8Array<ArrayBuffer> | null {
    if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
    try {
      const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
      return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    } catch {
      return null;
    }
  },
};

const ED = { name: "Ed25519" } as const;
const enc = new TextEncoder();

function bytesOf(s: string, what: string): Uint8Array<ArrayBuffer> {
  const b = b64.dec(s);
  if (!b) throw new Error(`${what} is not base64url`);
  return b;
}

/** The raw public key (`x`, base64url) of a PKCS#8 Ed25519 private key. */
export async function publicFromPkcs8(pkcs8: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "pkcs8",
    bytesOf(pkcs8, "private key"),
    ED,
    true,
    ["sign"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", k)) as JsonWebKey;
  if (!jwk.x) throw new Error("no public key");
  return jwk.x;
}

/**
 * The key id the registry stores and the install sends (X-OA-Kid): the first
 * 16 characters of base64url(SHA-256(raw public key)). Derived, never
 * configured, so it can't drift from the key on rotation.
 */
export async function keyId(x: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytesOf(x, "public key"));
  return b64.enc(new Uint8Array(d)).slice(0, 16);
}

/** Signs the exact request body bytes; base64url signature (X-OA-Sig). */
export async function signRedeem(pkcs8: string, body: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "pkcs8",
    bytesOf(pkcs8, "private key"),
    ED,
    false,
    ["sign"],
  );
  return b64.enc(
    new Uint8Array(await crypto.subtle.sign(ED, k, enc.encode(body))),
  );
}

/** Verifies `sig` over `body` with the raw public key `x`; false on any error. */
export async function verifyRedeem(
  x: string,
  body: string,
  sig: string,
): Promise<boolean> {
  try {
    const raw = b64.dec(x);
    const s = b64.dec(sig);
    if (!raw || raw.length !== 32 || !s || s.length !== 64) return false;
    const k = await crypto.subtle.importKey("raw", raw, ED, false, ["verify"]);
    return await crypto.subtle.verify(ED, k, s, enc.encode(body));
  } catch {
    return false;
  }
}
