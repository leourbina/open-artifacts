import { env } from "cloudflare:workers";
import { type Member, newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { sweepLoginCodes } from "../src/auth/codes.js";
import { scheduled } from "../src/cron.js";
import { publish } from "../src/services/artifacts.js";
import { patchMember, removeMember } from "../src/services/members.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

// P2 Task 3: migration 0008 (identities, login_codes, users.session_epoch,
// users.status) and the lifecycle hooks around them.
const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
const cols = async (table: string) =>
  (
    await env.DB.prepare(
      `select name, pk, "notnull" as nn, dflt_value as d from pragma_table_info('${table}') order by cid`,
    ).all<{ name: string; pk: number; nn: number; d: string | null }>()
  ).results;
const one = async <T>(sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...binds)
    .first<T>()) as T;
const epochOf = async (id: string) =>
  (
    await one<{ e: number }>(
      "select session_epoch e from users where id = ?",
      id,
    )
  ).e;
const exists = async (id: string) =>
  (await one<{ n: number }>("select count(*) n from users where id = ?", id))
    .n === 1;
const linkGoogle = (userId: string, sub: string) =>
  env.DB.prepare(
    "insert into identities (provider, subject, tenant, user_id, created_at) values ('google', ?, 'a.com', ?, ?)",
  )
    .bind(sub, userId, Date.now())
    .run();
const insertCode = (requestId: string, expiresAt: number) =>
  env.DB.prepare(
    "insert into login_codes (email_key, request_id, code_hash, expires_at, created_at) values (?, ?, 'h', ?, ?)",
  )
    .bind(`ek-${tag}`, requestId, expiresAt, Date.now())
    .run();

let owner: Member;
let ownerCookie: string;

beforeAll(async () => {
  // removeMember reassigns to the instance owner; the test DB needs one.
  await login(`s3-root-${tag}@a.com`, "owner");
  const o = await login(`s3-owner-${tag}@a.com`, "member");
  ownerCookie = o.cookie;
  owner = (await getUser(env, o.userId)) as Member;
});

describe("migration 0008", () => {
  it("adds users.session_epoch (0) and users.status ('active')", async () => {
    const c = await cols("users");
    expect(c.find((x) => x.name === "session_epoch")).toMatchObject({
      nn: 1,
      d: "0",
    });
    expect(c.find((x) => x.name === "status")).toMatchObject({
      nn: 1,
      d: "'active'",
    });
    const { userId } = await login(`s3-new-${tag}@a.com`);
    expect(
      await one<{ e: number; s: string }>(
        "select session_epoch e, status s from users where id = ?",
        userId,
      ),
    ).toEqual({ e: 0, s: "active" });
  });

  it("creates identities keyed by (provider, subject), one link per user and provider", async () => {
    const c = await cols("identities");
    expect(c.filter((x) => x.pk > 0).map((x) => x.name)).toEqual([
      "provider",
      "subject",
    ]);
    const { userId } = await login(`s3-link-${tag}@a.com`);
    await linkGoogle(userId, `S1-${tag}`);
    await expect(linkGoogle(userId, `S2-${tag}`)).rejects.toThrow(/UNIQUE/);
  });

  it("creates login_codes keyed by (email_key, request_id)", async () => {
    const c = await cols("login_codes");
    expect(c.filter((x) => x.pk > 0).map((x) => x.name)).toEqual([
      "email_key",
      "request_id",
    ]);
    expect(c.find((x) => x.name === "attempts")).toMatchObject({ d: "0" });
  });
});

describe("lifecycle", () => {
  it("removeMember deletes the member's identities", async () => {
    const { userId } = await login(`s3-rm-${tag}@a.com`);
    await linkGoogle(userId, `RM-${tag}`);
    await removeMember(env, userId);
    expect(
      await one<{ n: number }>(
        "select count(*) n from identities where user_id = ?",
        userId,
      ),
    ).toEqual({ n: 0 });
  });

  it("a role change bumps session_epoch", async () => {
    const { userId } = await login(`s3-role-${tag}@a.com`);
    await patchMember(env, userId, { role: "admin" });
    expect(await epochOf(userId)).toBe(1);
    await patchMember(env, userId, { role: "member" });
    expect(await epochOf(userId)).toBe(2);
  });

  it("deleting a guest's last share deletes the guest; a remaining share keeps them", async () => {
    const email = `s3-guest-${tag}@x.com`;
    const g = await login(email, "guest");
    const mk = async () =>
      (
        await publish(
          env,
          owner,
          { title: "t", format: "markdown", content: "x" } as never,
          null,
          undefined,
          "create",
        )
      ).id;
    const [a1, a2] = [await mk(), await mk()];
    for (const id of [a1, a2])
      expect(
        (
          await api(app, R.shares(id), ownerCookie, {
            method: "PUT",
            body: { email, role: "viewer" },
          })
        ).status,
      ).toBe(200);
    const del = (id: string) =>
      api(app, R.share(id, email), ownerCookie, { method: "DELETE" });
    expect((await del(a1)).status).toBe(204);
    expect(await exists(g.userId)).toBe(true);
    expect((await del(a2)).status).toBe(204);
    expect(await exists(g.userId)).toBe(false);
  });

  it("deleting a member's share never deletes the member", async () => {
    const email = `s3-keep-${tag}@x.com`;
    const m = await login(email, "member");
    const id = (
      await publish(
        env,
        owner,
        { title: "t", format: "markdown", content: "x" } as never,
        null,
        undefined,
        "create",
      )
    ).id;
    await api(app, R.shares(id), ownerCookie, {
      method: "PUT",
      body: { email, role: "viewer" },
    });
    await api(app, R.share(id, email), ownerCookie, { method: "DELETE" });
    expect(await exists(m.userId)).toBe(true);
  });
});

describe("login code sweep", () => {
  it("deletes expired codes only", async () => {
    const now = Date.now();
    await insertCode(`old-${tag}`, now - 1);
    await insertCode(`live-${tag}`, now + 60_000);
    await sweepLoginCodes(env, now);
    const left = await env.DB.prepare(
      "select request_id r from login_codes where email_key = ? order by r",
    )
      .bind(`ek-${tag}`)
      .all<{ r: string }>();
    expect(left.results.map((x) => x.r)).toEqual([`live-${tag}`]);
  });

  it("runs in the daily cron", async () => {
    await insertCode(`cron-${tag}`, Date.now() - 1);
    const waits: Promise<unknown>[] = [];
    await scheduled({} as ScheduledController, env, {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    } as never);
    await Promise.all(waits);
    expect(
      await one<{ n: number }>(
        "select count(*) n from login_codes where request_id = ?",
        `cron-${tag}`,
      ),
    ).toEqual({ n: 0 });
  });
});
