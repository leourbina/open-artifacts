// P3 Task 7: UserPresence closes a revoked user's live sockets at once.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type Member, newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  ACTOR_HEADER,
  AUTHZ_AT_HEADER,
  runtimeStub,
} from "../src/runtime/do.js";
import {
  CLOSE_FANOUT,
  RETRY_MAX_AGE_MS,
  retryBackoffMs,
  type UserPresence,
} from "../src/runtime/presence.js";
import { revokeUserLive } from "../src/runtime/revoke.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
type U = { cookie: string; userId: string; member: Member; email: string };
let owner: U;
let member: U;

async function mk(prefix: string, role: Member["role"]): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, role);
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}

const pub = async () =>
  (
    await publish(
      env,
      owner.member,
      {
        title: "presence",
        format: "html",
        content: "<p>x</p>",
        visibility: "team",
        capabilities: { db: true, viewer: true, storage: true },
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;

type Sock = { ws: WebSocket; closed: Promise<number>; isOpen: () => boolean };
function wrap(ws: WebSocket): Sock {
  let open = true;
  const closed = new Promise<number>((res) =>
    ws.addEventListener("close", (e) => {
      open = false;
      res((e as CloseEvent).code);
    }),
  );
  ws.accept();
  return { ws, closed, isOpen: () => open };
}
async function viaRoute(path: string, u: U): Promise<Sock> {
  const r = await api(app, path, u.cookie, {
    headers: { upgrade: "websocket", "cf-connecting-ip": "198.51.100.9" },
  });
  if (!r.webSocket) throw new Error(`no websocket (${r.status})`);
  return wrap(r.webSocket);
}
const openSockets = async (u: U, id: string) => ({
  data: await viaRoute(R.dataSubscribe(id, "c"), u),
  events: await viaRoute(R.events(id), u),
});

/** A data socket straight to the artifact DO, authorized at `authzAt`. */
async function direct(id: string, userId: string, authzAt: number) {
  const r = await runtimeStub(env, id).fetch(
    "https://runtime.invalid/subscribe?collection=c",
    {
      headers: {
        Upgrade: "websocket",
        [ACTOR_HEADER]: `u:${userId}`,
        [AUTHZ_AT_HEADER]: String(authzAt),
      },
    },
  );
  if (!r.webSocket) throw new Error(`no websocket (${r.status})`);
  return wrap(r.webSocket);
}

const presence = (userId: string) => {
  const ns = env.USER_PRESENCE;
  if (!ns) throw new Error("USER_PRESENCE unbound");
  return ns.get(ns.idFromName(userId));
};
const inPresence = <T>(
  userId: string,
  cb: (p: UserPresence) => T | Promise<T>,
) =>
  runInDurableObject(
    presence(userId) as unknown as DurableObjectStub<UserPresence>,
    cb,
  );
/**
 * A clock an hour ahead for queue tests: queued closes fall due then, so the
 * runtime never fires the alarm on its own mid-test (runDurableObjectAlarm
 * runs it on demand).
 */
const later = () => Date.now() + 3_600_000;
const tick = () => new Promise((r) => setTimeout(r, 50));

beforeAll(async () => {
  owner = await mk("pr-owner", "member");
  member = await mk("pr-member", "member");
});

describe("UserPresence", () => {
  it("suspending a user closes their data and events sockets with 4403", async () => {
    const u = await mk(`pr-s-${newId().slice(0, 4)}`, "member");
    const art = await pub();
    const ws = await openSockets(u, art);
    await env.DB.prepare("update users set status = 'suspended' where id = ?")
      .bind(u.userId)
      .run();
    await revokeUserLive(env, u.userId, "suspended");
    expect(await ws.data.closed).toBe(4403);
    expect(await ws.events.closed).toBe(4403);
  });

  it("socket accepted after revocation started is closed (authzAt <= revokedAt)", async () => {
    const uid = `pr-race-${newId()}`;
    const art = await pub();
    await revokeUserLive(env, uid, "removed");
    const revokedAt = await inPresence(uid, (p) => p.revokedAt());
    expect(revokedAt).not.toBeNull();
    const before = await direct(art, uid, (revokedAt as number) - 5);
    const same = await direct(art, uid, revokedAt as number);
    expect(await before.closed).toBe(4403);
    expect(await same.closed).toBe(4403);
    // Authorized after the revocation (a reactivated user): stays open.
    const after = await direct(art, uid, (revokedAt as number) + 1);
    await tick();
    expect(after.isOpen()).toBe(true);
    after.ws.close();
  });

  it("other users' sockets stay open", async () => {
    const u = await mk(`pr-o-${newId().slice(0, 4)}`, "member");
    const art = await pub();
    const mine = await openSockets(u, art);
    const theirs = await openSockets(member, art);
    await revokeUserLive(env, u.userId, "suspended");
    expect(await mine.data.closed).toBe(4403);
    expect(await mine.events.closed).toBe(4403);
    await tick();
    expect(theirs.data.isOpen()).toBe(true);
    expect(theirs.events.isOpen()).toBe(true);
    theirs.data.ws.close();
    theirs.events.ws.close();
  });

  it("closeAll sets revokedAt before any closeActor call", async () => {
    const uid = `pr-order-${newId()}`;
    const seen: (number | null)[] = [];
    const n = await inPresence(uid, async (p) => {
      p.touch("art-a", Date.now());
      p.touch("art-b", Date.now());
      p.closer = async () => {
        seen.push(p.revokedAt());
        return 1;
      };
      return p.closeAll("suspended");
    });
    expect(n).toBe(2);
    expect(seen).toHaveLength(2);
    for (const t of seen) expect(t).toEqual(expect.any(Number));
  });

  it("a failed closeActor is retried from the queue", async () => {
    const uid = `pr-retry-${newId()}`;
    const art = await pub();
    const s = await direct(art, uid, Date.now());
    let calls = 0;
    // Within the socket TTL of the touch above, still far from due.
    const base = Date.now() + 300_000;
    await inPresence(uid, async (p) => {
      p.now = () => base;
      const real = p.closer;
      p.closer = async (...a) => {
        if (++calls === 1) throw new Error("boom");
        return real(...a);
      };
      expect(await p.closeAll("suspended")).toBe(0);
      expect(p.pendingRetries()).toMatchObject([
        { artifactId: art, attempts: 1 },
      ]);
    });
    expect(s.isOpen()).toBe(true);
    // Make the queued retry due, then fire the alarm.
    await inPresence(uid, (p) => {
      p.now = () => base + retryBackoffMs(1);
    });
    expect(await runDurableObjectAlarm(presence(uid))).toBe(true);
    expect(await s.closed).toBe(4403);
    expect(calls).toBe(2);
    expect(await inPresence(uid, (p) => p.pendingRetries())).toEqual([]);
  });

  it("failures back off and are dropped once 11 minutes old", async () => {
    const uid = `pr-expire-${newId()}`;
    const t0 = later();
    await inPresence(uid, async (p) => {
      p.now = () => t0;
      p.touch("art-x", t0);
      p.closer = async () => {
        throw new Error("down");
      };
      await p.closeAll("suspended");
      p.now = () => t0 + retryBackoffMs(1);
    });
    await runDurableObjectAlarm(presence(uid));
    const [r] = await inPresence(uid, (p) => p.pendingRetries());
    expect(r).toMatchObject({ attempts: 2, due: t0 + retryBackoffMs(1) * 3 });
    await inPresence(uid, (p) => {
      p.now = () => t0 + RETRY_MAX_AGE_MS + 1;
    });
    await runDurableObjectAlarm(presence(uid));
    expect(await inPresence(uid, (p) => p.pendingRetries())).toEqual([]);
  });

  it("closes past CLOSE_FANOUT wait in the queue for the alarm", async () => {
    const uid = `pr-fan-${newId()}`;
    let calls = 0;
    const base = later();
    await inPresence(uid, async (p) => {
      p.now = () => base;
      for (let i = 0; i < CLOSE_FANOUT + 3; i++) p.touch(`art-${i}`, 1);
      p.closer = async () => {
        calls++;
        return 0;
      };
      await p.closeAll("removed");
      expect(calls).toBe(CLOSE_FANOUT);
      expect(p.pendingRetries()).toHaveLength(3);
    });
    expect(await runDurableObjectAlarm(presence(uid))).toBe(true);
    expect(calls).toBe(CLOSE_FANOUT + 3);
    expect(await inPresence(uid, (p) => p.pendingRetries())).toEqual([]);
  });

  it("revokeUserLive never throws", async () => {
    await expect(
      revokeUserLive({ USER_PRESENCE: undefined }, "u1", "x"),
    ).resolves.toBeUndefined();
    const broken = {
      USER_PRESENCE: {
        idFromName: () => {
          throw new Error("boom");
        },
      } as never,
    };
    await expect(revokeUserLive(broken, "u1", "x")).resolves.toBeUndefined();
    const ctx = {
      waitUntil: () => {
        throw new Error("no ctx");
      },
    };
    await expect(
      revokeUserLive(broken, "u1", "x", ctx),
    ).resolves.toBeUndefined();
  });

  it("a signed-in socket without an authorization time is refused", async () => {
    const art = await pub();
    const r = await runtimeStub(env, art).fetch(
      "https://runtime.invalid/subscribe?collection=c",
      { headers: { Upgrade: "websocket", [ACTOR_HEADER]: "u:someone" } },
    );
    expect(r.status).toBe(400);
  });

  it("closeActor closes only that actor's data and events sockets", async () => {
    const art = await pub();
    const a = await openSockets(member, art);
    const b = await direct(art, `pr-b-${newId()}`, Date.now());
    const n = await runtimeStub(env, art).closeActor(`u:${member.userId}`, "x");
    expect(n).toBe(2);
    expect(await a.data.closed).toBe(4403);
    expect(await a.events.closed).toBe(4403);
    await tick();
    expect(b.isOpen()).toBe(true);
    b.ws.close();
  });
});
