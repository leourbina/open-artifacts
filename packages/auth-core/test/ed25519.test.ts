import { describe, expect, test } from "vitest";
import {
  keyId,
  publicFromPkcs8,
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

  test("a signature verifies over exactly the signed body", async () => {
    const body = '{"install":"a","code":"c","verifier":"v","ts":1}';
    const sig = await signRedeem(pkcs8, body);
    expect(await verifyRedeem(x, body, sig)).toBe(true);
    expect(await verifyRedeem(x, body.replace('"a"', '"b"'), sig)).toBe(false);
    expect(await verifyRedeem(x, `${body} `, sig)).toBe(false);
  });

  test("another key's signature and garbage are refused", async () => {
    const other = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.alloc(32, 7),
    ]).toString("base64url");
    const body = "{}";
    expect(await verifyRedeem(x, body, await signRedeem(other, body))).toBe(
      false,
    );
    expect(await verifyRedeem(x, body, "not-a-sig")).toBe(false);
    expect(await verifyRedeem("bad", body, await signRedeem(pkcs8, body))).toBe(
      false,
    );
  });
});
