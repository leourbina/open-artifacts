import { describe, expect, test } from "vitest";
import {
  brokerNonce,
  flowHash,
  keyId,
  publicFromPkcs8,
  redeemTranscript,
  signRedeem,
  verifyRedeem,
} from "../src/ed25519.js";

// RFC 8032 test 1 private seed, as PKCS#8 DER base64url, and its public key.
const SEED_HEX =
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PUB_HEX =
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const pkcs8 = Buffer.concat([
  Buffer.from("302e020100300506032b657004220420", "hex"),
  Buffer.from(SEED_HEX, "hex"),
]).toString("base64url");
const x = Buffer.from(PUB_HEX, "hex").toString("base64url");

describe("ed25519 request signing", () => {
  test("derives the public key from the PKCS#8 private key", async () => {
    expect(await publicFromPkcs8(pkcs8)).toBe(x);
  });

  test("keyId is the first 16 chars of base64url(SHA-256(raw public key))", async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      Buffer.from(PUB_HEX, "hex"),
    );
    expect(await keyId(x)).toBe(
      Buffer.from(digest).toString("base64url").slice(0, 16),
    );
    expect((await keyId(x)).length).toBe(16);
  });

  test("a signature verifies over exactly the signed transcript", async () => {
    const body = '{"install":"a","code":"c","verifier":"v","ts":1}';
    const kid = await keyId(x);
    const sig = await signRedeem(pkcs8, kid, body);
    expect(await verifyRedeem(x, kid, body, sig)).toBe(true);
    expect(await verifyRedeem(x, kid, body.replace('"a"', '"b"'), sig)).toBe(
      false,
    );
    expect(await verifyRedeem(x, kid, `${body} `, sig)).toBe(false);
    // The kid is part of the transcript: the same body can't be replayed
    // under another kid, nor the signature transplanted to another path.
    expect(await verifyRedeem(x, "another-kid-0000", body, sig)).toBe(false);
    expect(redeemTranscript(kid, body)).toBe(
      `oa-redeem-v1\nPOST\n/google/redeem\n${kid}\n${body}`,
    );
  });

  test("another key's signature and garbage are refused", async () => {
    const other = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.alloc(32, 7),
    ]).toString("base64url");
    const body = "{}";
    const kid = await keyId(x);
    expect(
      await verifyRedeem(x, kid, body, await signRedeem(other, kid, body)),
    ).toBe(false);
    expect(await verifyRedeem(x, kid, body, "not-a-sig")).toBe(false);
    expect(
      await verifyRedeem("bad", kid, body, await signRedeem(pkcs8, kid, body)),
    ).toBe(false);
  });

  test("the broker nonce is install-bound and differs per install", async () => {
    const a = await brokerNonce("inst-a", "client-nonce");
    const b = await brokerNonce("inst-b", "client-nonce");
    expect(a).not.toBe(b);
    expect(a).not.toBe("client-nonce");
    expect(a).toBe(
      Buffer.from(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode("oa-broker-v1|inst-a|client-nonce"),
        ),
      ).toString("base64url"),
    );
    expect(await brokerNonce("inst-a", "client-nonce")).toBe(a);
  });

  test("the flow hash is H(client nonce | challenge), base64url", async () => {
    const h = await flowHash("n1", "ch");
    expect(h).toBe(
      Buffer.from(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode("n1|ch"),
        ),
      ).toString("base64url"),
    );
    expect(await flowHash("n2", "ch")).not.toBe(h);
  });
});
