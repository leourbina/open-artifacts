// PUT R.dataReset: owner-only atomic replace of an artifact's data docs.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  DataDocSchema,
  DataResetResultSchema,
  dataResetTooLargeMessage,
  LIMITS,
  type Member,
  newId,
  PageSchema,
  R,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, errOf, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
type U = { cookie: string; userId: string; member: Member; email: string };
let owner: U;
let viewer: U;
let editor: U;
let pat: string;

async function mk(prefix: string): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, "member");
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}

const pub = async (extra: Record<string, unknown> = {}) =>
  (
    await publish(
      env,
      owner.member,
      {
        title: "live",
        format: "html",
        content: "<p>hi</p>",
        capabilities: { db: true },
        visibility: "team",
        ...extra,
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;

const reset = (id: string, auth: string | null, body: unknown) =>
  api(app, R.dataReset(id), auth, { method: "PUT", body });

const docs = async (id: string, col: string) => {
  const r = await api(app, R.dataCollection(id, col), owner.cookie);
  expect(r.status).toBe(200);
  return Object.fromEntries(
    PageSchema(DataDocSchema)
      .parse(await r.json())
      .items.map((d) => [d.id, d.data]),
  );
};

const seed = async (id: string) => {
  for (const [col, doc, data] of [
    ["a", "1", { old: 1 }],
    ["a", "2", { old: 2 }],
    ["b", "1", { old: 3 }],
  ] as const) {
    const r = await api(app, R.dataDoc(id, col, doc), owner.cookie, {
      method: "PUT",
      body: data,
    });
    expect(r.status).toBe(200);
  }
};
const OLD = { a: { "1": { old: 1 }, "2": { old: 2 } }, b: { "1": { old: 3 } } };
const expectOld = async (id: string) => {
  expect(await docs(id, "a")).toEqual(OLD.a);
  expect(await docs(id, "b")).toEqual(OLD.b);
};

const SNAP = {
  collections: {
    a: { x: { n: 1 } },
    c: { y: [1, "two"], z: null },
    empty: {},
  },
};

const inDo = <T>(id: string, cb: (i: ArtifactRuntime) => T) =>
  runInDurableObject(
    runtimeStub(env, id) as unknown as DurableObjectStub<ArtifactRuntime>,
    cb,
  );

beforeAll(async () => {
  owner = await mk("reset-owner");
  viewer = await mk("reset-viewer");
  editor = await mk("reset-editor");
  pat = (await createPat(env, owner.userId, "demo")).token;
});

describe("PUT R.dataReset", () => {
  it("replaces all docs with the snapshot (PAT), idempotently", async () => {
    const id = await pub();
    await seed(id);
    const r1 = await reset(id, pat, SNAP);
    expect(r1.status).toBe(200);
    const res = DataResetResultSchema.parse(await r1.json());
    expect(res).toMatchObject({ collections: 3, docs: 3 });
    const check = async () => {
      expect(await docs(id, "a")).toEqual({ x: { n: 1 } });
      expect(await docs(id, "b")).toEqual({});
      expect(await docs(id, "c")).toEqual({ y: [1, "two"], z: null });
    };
    await check();
    const one = await api(app, R.dataDoc(id, "a", "x"), owner.cookie);
    expect(DataDocSchema.parse(await one.json())).toMatchObject({
      updatedAt: res.updatedAt,
      updatedBy: `u:${owner.userId}`,
    });
    const bytes = await inDo(id, (i) => i.totalBytes());
    const r2 = await reset(id, pat, SNAP);
    expect(r2.status).toBe(200);
    await check();
    expect(await inDo(id, (i) => i.totalBytes())).toBe(bytes);
    // An empty snapshot clears everything; totals go back to zero.
    expect((await reset(id, pat, { collections: {} })).status).toBe(200);
    expect(await docs(id, "a")).toEqual({});
    expect(await inDo(id, (i) => i.totalBytes())).toBe(0);
  });

  it("session works with the CSRF header; without it 403 csrf", async () => {
    const id = await pub();
    expect((await reset(id, owner.cookie, SNAP)).status).toBe(200);
    const r = await app.fetch(
      new Request(`http://app.localhost${R.dataReset(id)}`, {
        method: "PUT",
        headers: { cookie: owner.cookie, "content-type": "application/json" },
        body: JSON.stringify(SNAP),
      }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    expect(r.status).toBe(403);
    expect((await errOf(r)).code).toBe("csrf");
  });

  it("non-owners get 404 (viewer, editor, anonymous); data untouched", async () => {
    const id = await pub({ visibility: "public" });
    await seed(id);
    const s = await api(app, R.shares(id), owner.cookie, {
      method: "PUT",
      body: { email: editor.email, role: "editor" },
    });
    expect(s.status).toBe(200);
    for (const who of [viewer.cookie, editor.cookie, null]) {
      const r = await reset(id, who, SNAP);
      expect(r.status).toBe(404);
      expect((await errOf(r)).code).toBe("not_found");
    }
    await expectOld(id);
  });

  it("no db capability → 403 capability_denied", async () => {
    const id = await pub({ capabilities: { db: false } });
    const r = await reset(id, pat, SNAP);
    expect(r.status).toBe(403);
    expect((await errOf(r)).code).toBe("capability_denied");
  });

  it("caps: body size (413 before reading), doc and collection counts, per-doc size, names", async () => {
    const id = await pub();
    await seed(id);
    const big = await app.fetch(
      new Request(`http://app.localhost${R.dataReset(id)}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${pat}`,
          "content-length": String(LIMITS.dataResetBytesFree + 1),
        },
        body: "x".repeat(LIMITS.dataResetBytesFree + 1),
      }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    expect(big.status).toBe(413);
    expect((await errOf(big)).message).toBe(dataResetTooLargeMessage("free"));

    const many = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`d${i}`, i]));
    const tooManyDocs = await reset(id, pat, {
      collections: { a: many(300), b: many(LIMITS.dataResetDocsFree - 299) },
    });
    expect(tooManyDocs.status).toBe(400);
    const tooManyCols = await reset(id, pat, {
      collections: Object.fromEntries(
        Array.from({ length: LIMITS.dataResetCollections + 1 }, (_, i) => [
          `c${i}`,
          {},
        ]),
      ),
    });
    expect(tooManyCols.status).toBe(400);
    const bigDoc = await reset(id, pat, {
      collections: {
        a: { ok: 1, huge: "x".repeat(LIMITS.dataDocBytesFree) },
      },
    });
    expect(bigDoc.status).toBe(413);
    for (const bad of [
      { collections: { "a b": {} } },
      { collections: { a: { "x.y": 1 } } },
      { collections: { a: [1] } },
      { collections: [] },
      { collections: {}, extra: 1 },
      {},
      [],
      "nope",
    ]) {
      const r = await reset(id, pat, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    // Exactly at the doc cap is fine.
    const atCap = await reset(id, pat, {
      collections: { a: many(LIMITS.dataResetDocsFree) },
    });
    expect(atCap.status).toBe(200);
    expect(DataResetResultSchema.parse(await atCap.json()).docs).toBe(
      LIMITS.dataResetDocsFree,
    );
  });

  it("is atomic: a failure inside the transaction leaves the old data", async () => {
    const id = await pub();
    await seed(id);
    const before = await inDo(id, (i) => i.totalBytes());
    // Push the tracked total to the 50 MB cap: the reset's own bytes now trip it
    // after the delete and the inserts, inside the transaction.
    await inDo(id, (i) => {
      (i as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
        "update totals set bytes = ?",
        LIMITS.artifactDataBytes,
      );
    });
    const r = await reset(id, pat, {
      collections: { a: { x: "x".repeat(4096) }, c: { y: 1 } },
    });
    expect(r.status).toBe(413);
    await expectOld(id);
    await inDo(id, (i) => {
      (i as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
        "update totals set bytes = ?",
        before,
      );
    });
    // A validation failure late in the snapshot also changes nothing.
    const bad = await reset(id, pat, {
      collections: { a: { x: 1 }, z: { "bad id": 1 } },
    });
    expect(bad.status).toBe(400);
    await expectOld(id);
  });

  it("closes live subscribers (1012) so each viewer resyncs", async () => {
    const id = await pub();
    const r = await api(app, R.dataSubscribe(id, "a"), viewer.cookie, {
      headers: { upgrade: "websocket" },
    });
    const ws = r.webSocket;
    if (!ws) throw new Error(`no websocket (${r.status})`);
    ws.accept();
    const code = new Promise<number>((res) =>
      ws.addEventListener("close", (e) => res((e as CloseEvent).code)),
    );
    expect((await reset(id, pat, SNAP)).status).toBe(200);
    expect(await code).toBe(1012);
  });

  it('keeps a "__proto__" doc id (no prototype pollution)', async () => {
    const id = await pub();
    const r = await api(app, R.dataReset(id), pat, {
      method: "PUT",
      body: JSON.parse('{"collections":{"a":{"__proto__":{"p":1},"q":2}}}'),
    });
    expect(r.status).toBe(200);
    expect(DataResetResultSchema.parse(await r.json()).docs).toBe(2);
    expect(await docs(id, "a")).toEqual(
      JSON.parse('{"__proto__":{"p":1},"q":2}'),
    );
  });
});
