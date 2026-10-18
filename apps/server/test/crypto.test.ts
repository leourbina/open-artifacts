import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hmacSign, hmacVerify, sha256Hex } from "../src/util/crypto.js";

const K = env.SESSION_SECRET;

describe("crypto", () => {
  it("sha256Hex known vector", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  it("sign/verify round trip", async () => {
    expect(await hmacVerify(K, "d", await hmacSign(K, "d"))).toBe(true);
  });
  it("rejects tampered, wrong key, wrong data", async () => {
    const sig = await hmacSign(K, "d");
    expect(await hmacVerify(K, "d", `${sig.slice(0, -2)}AA`)).toBe(false);
    expect(await hmacVerify("other-key", "d", sig)).toBe(false);
    expect(await hmacVerify(K, "e", sig)).toBe(false);
  });
  it("rejects malformed and non-canonical b64", async () => {
    const sig = await hmacSign(K, "d"); // 43 chars, last char carries 4 unused bits
    expect(await hmacVerify(K, "d", "!!!")).toBe(false);
    expect(await hmacVerify(K, "d", "")).toBe(false);
    expect(await hmacVerify(K, "d", `${sig}=`)).toBe(false);
    expect(await hmacVerify(K, "d", `${sig}A`)).toBe(false);
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const i = alphabet.indexOf(sig.slice(-1));
    const alt = alphabet[i ^ 1] as string; // differs only in unused low bit
    expect(await hmacVerify(K, "d", sig.slice(0, -1) + alt)).toBe(false);
  });
});
