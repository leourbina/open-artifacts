import { describe, expect, test } from "vitest";
import { deriveKey, KEY_LABELS } from "../src/auth/keys.js";

const secret = { SESSION_SECRET: "x".repeat(32) };

describe("deriveKey", () => {
  test("is pinned: HKDF-SHA256, salt open-artifacts/hkdf/v1, 32 bytes", async () => {
    // Computed independently with Node's crypto.hkdfSync.
    expect(await deriveKey(secret, "oa:session")).toBe(
      "yXeICrivwL9bXFq_zsp5_7RovBx9ThtWf_cqvN9nHOg",
    );
  });

  test("labels give distinct keys", async () => {
    const ks = await Promise.all(KEY_LABELS.map((l) => deriveKey(secret, l)));
    expect(new Set(ks).size).toBe(KEY_LABELS.length);
    expect(KEY_LABELS).toEqual([
      "oa:session",
      "oa:oidc-state",
      "oa:code-cookie",
      "oa:login-codes",
      "oa:code-email",
    ]);
  });

  test("depends on the secret", async () => {
    expect(
      await deriveKey({ SESSION_SECRET: "y".repeat(32) }, "oa:session"),
    ).not.toBe(await deriveKey(secret, "oa:session"));
  });

  test("refuses an empty secret, derives from a short one", async () => {
    await expect(
      deriveKey({ SESSION_SECRET: "" }, "oa:session"),
    ).rejects.toThrow("SESSION_SECRET is not set");
    // HKDF accepts any length: a short secret is weak, not unusable.
    await expect(
      deriveKey({ SESSION_SECRET: "short" }, "oa:session"),
    ).resolves.toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
