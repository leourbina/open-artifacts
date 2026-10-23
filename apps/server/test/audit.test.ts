import { env } from "cloudflare:workers";
import { type AuditEvent, type Member, newId, R } from "@oa/shared";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { authConfig } from "../src/auth/config.js";
import { audit } from "../src/services/audit.js";
import { admit, resetIdentity } from "../src/services/identity.js";
import { direct, seedUser, uniq } from "./auth-helpers.js";
import { api, login } from "./helpers.js";

// P3 Task 8: audit rows commit in the same batch as the change they record.
const app = createApp();

type AuditRow = {
  action: string;
  target_type: string;
  target_id: string;
  actor_kind: string;
  actor_id: string | null;
  space_id: string | null;
  detail: string;
};
const count = async (where = "1", ...b: unknown[]) =>
  (
    (await env.DB.prepare(`select count(*) n from audit_events where ${where}`)
      .bind(...b)
      .first<{ n: number }>()) as { n: number }
  ).n;
const rowsFor = async (targetId: string) =>
  (
    await env.DB.prepare(
      "select * from audit_events where target_id = ? order by at",
    )
      .bind(targetId)
      .all<AuditRow>()
  ).results;
const lastAudit = async (targetId: string) => (await rowsFor(targetId)).at(-1);

let owner: { cookie: string; userId: string };
let admin: { cookie: string; userId: string };
let member: { cookie: string; userId: string };
let guest: { cookie: string; userId: string };

beforeAll(async () => {
  owner = await login(uniq("owner"), "owner");
  admin = await login(uniq("admin"), "admin");
  member = await login(uniq("member"));
  guest = await login(uniq("guest", "out.com"), "guest");
});

async function publish(cookie: string, visibility?: string): Promise<string> {
  const r = await api(app, R.artifacts, cookie, {
    method: "POST",
    body: {
      title: "Audited",
      format: "markdown",
      content: "# hi",
      ...(visibility ? { visibility } : {}),
    },
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}
const share = (cookie: string, id: string, email: string, role = "viewer") =>
  api(app, R.shares(id), cookie, { method: "PUT", body: { email, role } });

/** A trigger that fails every audit insert (the atomicity tests). */
const FAIL =
  "create trigger if not exists audit_fail before insert on audit_events begin select raise(abort, 'audit down'); end";
const failAudit = () => env.DB.prepare(FAIL).run();
afterEach(async () => {
  await env.DB.prepare("drop trigger if exists audit_fail").run();
});

describe("audit()", () => {
  it("returns a statement for the caller's batch; reason and detail read back", async () => {
    const target = uniq("t");
    const s = audit(
      env,
      "user.status",
      { type: "user", id: target },
      { kind: "sync", id: null },
      { reason: "directory_suspend", detail: { status: "suspended" } },
    );
    expect(await count("target_id = ?", target)).toBe(0);
    await env.DB.batch([s]);
    const r = await lastAudit(target);
    expect(r).toMatchObject({ action: "user.status", actor_kind: "sync" });
    expect(JSON.parse(r?.detail ?? "")).toEqual({
      status: "suspended",
      reason: "directory_suspend",
    });
  });
});

describe("shares", () => {
  it("artifact.share writes one audit row in the share batch", async () => {
    const art = await publish(owner.cookie);
    const before = await count();
    expect((await share(owner.cookie, art, "x@y.com")).status).toBe(200);
    expect(await count()).toBe(before + 1);
    const r = await lastAudit(art);
    expect(r).toMatchObject({
      action: "artifact.share",
      target_type: "artifact",
      target_id: art,
      actor_kind: "user",
      actor_id: owner.userId,
      space_id: owner.userId,
    });
    // Never the grantee's address.
    expect(r?.detail).not.toContain("@");
    expect(JSON.parse(r?.detail ?? "")).toEqual({ role: "viewer" });
  });

  it("a share refused at the cap writes no audit row", async () => {
    const art = await publish(owner.cookie);
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: 200 }, (_, i) =>
        env.DB.prepare(
          "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, 'viewer', ?, ?)",
        ).bind(art, `cap${i}@y.com`, owner.userId, now),
      ),
    );
    expect((await share(owner.cookie, art, "over@y.com")).status).toBe(400);
    expect(await rowsFor(art)).toHaveLength(0);
  });

  it("artifact.unshare writes one row; a missing share writes none", async () => {
    const art = await publish(owner.cookie);
    await share(owner.cookie, art, "gone@y.com");
    const del = (e: string) =>
      api(app, R.share(art, e), owner.cookie, { method: "DELETE" });
    expect((await del("gone@y.com")).status).toBe(204);
    expect((await lastAudit(art))?.action).toBe("artifact.unshare");
    const n = (await rowsFor(art)).length;
    expect((await del("never@y.com")).status).toBe(404);
    expect(await rowsFor(art)).toHaveLength(n);
  });

  it("a failing audit insert rolls the share back", async () => {
    const art = await publish(owner.cookie);
    await failAudit();
    expect((await share(owner.cookie, art, "atomic@y.com")).status).toBe(500);
    const s = await env.DB.prepare(
      "select count(*) n from shares where artifact_id = ?",
    )
      .bind(art)
      .first<{ n: number }>();
    expect(s?.n).toBe(0);
  });

  it("a failing audit insert keeps the share on unshare", async () => {
    const art = await publish(owner.cookie);
    await share(owner.cookie, art, "kept@y.com");
    await failAudit();
    const r = await api(app, R.share(art, "kept@y.com"), owner.cookie, {
      method: "DELETE",
    });
    expect(r.status).toBe(500);
    const s = await env.DB.prepare(
      "select count(*) n from shares where artifact_id = ?",
    )
      .bind(art)
      .first<{ n: number }>();
    expect(s?.n).toBe(1);
  });
});

describe("visibility", () => {
  const patch = (id: string, body: unknown) =>
    api(app, R.artifact(id), owner.cookie, { method: "PATCH", body });

  it("PATCH visibility writes artifact.visibility with from and to", async () => {
    const art = await publish(owner.cookie, "private");
    expect((await patch(art, { visibility: "team" })).status).toBe(200);
    const r = await lastAudit(art);
    expect(r).toMatchObject({
      action: "artifact.visibility",
      target_id: art,
      actor_id: owner.userId,
      space_id: owner.userId,
    });
    expect(JSON.parse(r?.detail ?? "")).toEqual({
      from: "private",
      to: "team",
    });
  });

  it("an unchanged visibility or a title edit writes no row", async () => {
    const art = await publish(owner.cookie, "team");
    await patch(art, { visibility: "team" });
    await patch(art, { title: "Renamed" });
    expect(await rowsFor(art)).toHaveLength(0);
  });

  it("a new version that changes visibility is audited", async () => {
    const art = await publish(owner.cookie, "private");
    const r = await api(app, R.versions(art), owner.cookie, {
      method: "POST",
      body: { format: "markdown", content: "# v2", visibility: "team" },
    });
    expect(r.status).toBe(201);
    expect(await lastAudit(art)).toMatchObject({
      action: "artifact.visibility",
    });
  });

  it("a failing audit insert rolls the visibility change back", async () => {
    const art = await publish(owner.cookie, "private");
    await failAudit();
    expect((await patch(art, { visibility: "team" })).status).toBe(500);
    const a = await env.DB.prepare(
      "select visibility v from artifacts where id = ?",
    )
      .bind(art)
      .first<{ v: string }>();
    expect(a?.v).toBe("private");
  });
});

describe("sign-in and identity", () => {
  it("sign-in is audited as auth.signin", async () => {
    const r = await admit(env, authConfig(direct()), {
      provider: "google",
      subject: `sub-${crypto.randomUUID()}`,
      email: uniq("signin"),
      name: "S",
      tenant: "a.com",
    });
    if (!r.ok) throw new Error(r.reason);
    const row = await lastAudit(r.user.id);
    expect(row).toMatchObject({
      action: "auth.signin",
      target_type: "user",
      actor_id: r.user.id,
    });
    expect(JSON.parse(row?.detail ?? "")).toEqual({
      provider: "google",
      tenant: "a.com",
    });
  });

  it("a failing audit insert fails the sign-in", async () => {
    await failAudit();
    await expect(
      admit(env, authConfig(direct()), {
        provider: "google",
        subject: `sub-${crypto.randomUUID()}`,
        email: uniq("signin"),
        name: "S",
        tenant: "a.com",
      }),
    ).rejects.toThrow();
  });

  it("identity.reset is audited in the reset batch", async () => {
    const uid = await seedUser(uniq("linked"), "member", {
      googleSub: `sub-${crypto.randomUUID()}`,
    });
    const actor = { id: admin.userId, role: "admin" } as Member;
    await resetIdentity(env, actor, uid);
    expect(await lastAudit(uid)).toMatchObject({
      action: "identity.reset",
      actor_id: admin.userId,
    });
  });

  it("a failing audit insert keeps the Google link", async () => {
    const uid = await seedUser(uniq("linked"), "member", {
      googleSub: `sub-${crypto.randomUUID()}`,
    });
    await failAudit();
    const actor = { id: admin.userId, role: "admin" } as Member;
    await expect(resetIdentity(env, actor, uid)).rejects.toThrow();
    const l = await env.DB.prepare(
      "select count(*) n from identities where user_id = ?",
    )
      .bind(uid)
      .first<{ n: number }>();
    expect(l?.n).toBe(1);
  });
});

describe("R.audit and R.auditExport", () => {
  it("member and guest get 404 on /audit", async () => {
    for (const who of [member, guest]) {
      expect((await api(app, R.audit, who.cookie)).status).toBe(404);
      expect((await api(app, R.auditExport, who.cookie)).status).toBe(404);
    }
    expect((await api(app, R.audit, null)).status).toBe(401);
  });

  it("owners and admins page newest first with a cursor", async () => {
    const tag = uniq("page");
    const base = Date.now() + 10_000_000;
    await env.DB.batch(
      [0, 1, 2].map((i) =>
        env.DB.prepare(
          "insert into audit_events (id, at, actor_kind, actor_id, action, target_type, target_id, detail) values (?, ?, 'user', ?, 'space.create', 'space', ?, '{}')",
        ).bind(newId(), base + i, owner.userId, `${tag}-${i}`),
      ),
    );
    const p1 = await api(app, `${R.audit}?limit=2`, owner.cookie);
    expect(p1.status).toBe(200);
    const b1 = (await p1.json()) as { items: AuditEvent[]; nextCursor: string };
    expect(b1.items.map((e) => e.target.id)).toEqual([`${tag}-2`, `${tag}-1`]);
    expect(b1.items[0]).toMatchObject({
      action: "space.create",
      actor: { kind: "user", id: owner.userId },
      reason: null,
      detail: null,
    });
    expect(b1.items[0]?.actor.email).toContain("owner");
    const p2 = await api(
      app,
      `${R.audit}?limit=2&cursor=${b1.nextCursor}`,
      admin.cookie,
    );
    const b2 = (await p2.json()) as { items: AuditEvent[] };
    expect(b2.items[0]?.target.id).toBe(`${tag}-0`);
    expect(
      (await api(app, `${R.audit}?cursor=nope!`, admin.cookie)).status,
    ).toBe(400);
    expect((await api(app, `${R.audit}?limit=0`, admin.cookie)).status).toBe(
      400,
    );
  });

  it("export streams NDJSON with one line per event", async () => {
    const n = await count("actor_kind in ('user', 'sync', 'system')");
    const r = await api(app, R.auditExport, admin.cookie);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await r.text()).split("\n").filter(Boolean);
    expect(lines.length).toBe(n);
    for (const l of lines) expect(JSON.parse(l)).toHaveProperty("action");
  });
});
