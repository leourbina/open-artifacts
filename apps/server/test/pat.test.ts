import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createPat, verifyPat } from "../src/auth/pat.js";
import { getDb } from "../src/db/client.js";
import { tokens } from "../src/db/schema.js";
import { sha256Hex } from "../src/util/crypto.js";
import { login } from "./helpers.js";

describe("pat", () => {
  it("stores only the hash and verifies", async () => {
    const { userId } = await login("pat1@x.com");
    const { id, token } = await createPat(env, userId, "ci");
    const row = await env.DB.prepare("select * from tokens where id=?")
      .bind(id)
      .first<Record<string, unknown>>();
    expect(Object.values(row ?? {})).not.toContain(token);
    expect(row?.token_hash).toBe(await sha256Hex(token));
    expect(await verifyPat(env, token)).toEqual({
      userId,
      tokenId: id,
      label: "ci",
    });
  });
  it("updates last_used_at at most hourly", async () => {
    const { userId } = await login("pat2@x.com");
    const { id, token } = await createPat(env, userId, "l");
    await verifyPat(env, token);
    const db = getDb(env);
    const get = async () =>
      (await db.select().from(tokens).where(eq(tokens.id, id)))[0]?.lastUsedAt;
    const first = await get();
    expect(first).toBeTypeOf("number");
    await db.update(tokens).set({ lastUsedAt: 5 }).where(eq(tokens.id, id));
    await verifyPat(env, token);
    expect(await get()).toBeGreaterThan(5);
    const recent = Date.now();
    await db
      .update(tokens)
      .set({ lastUsedAt: recent })
      .where(eq(tokens.id, id));
    await verifyPat(env, token);
    expect(await get()).toBe(recent);
  });
  it("uses ctx.waitUntil when given", async () => {
    const { userId } = await login("pat3@x.com");
    const { token } = await createPat(env, userId, "l");
    const ps: Promise<unknown>[] = [];
    await verifyPat(env, token, {
      waitUntil: (p: Promise<unknown>) => ps.push(p),
    } as unknown as ExecutionContext);
    expect(ps).toHaveLength(1);
    await Promise.all(ps);
  });
  it("null after revoke and for malformed/unknown", async () => {
    const { userId } = await login("pat4@x.com");
    const { id, token } = await createPat(env, userId, "l");
    await getDb(env)
      .update(tokens)
      .set({ revokedAt: Date.now() })
      .where(eq(tokens.id, id));
    expect(await verifyPat(env, token)).toBeNull();
    expect(await verifyPat(env, "nope")).toBeNull();
    expect(
      await verifyPat(
        env,
        `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`,
      ),
    ).toBeNull();
  });
});
