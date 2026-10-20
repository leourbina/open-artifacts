// The app shell must never carry a CSP `sandbox` (it would make the SPA an
// opaque origin and break cookies, storage and the API). Only the content
// host is sandboxed.
import { env } from "cloudflare:workers";
import { type Member, newId, viewerPath } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { publicPrefix } from "../src/content/signing.js";
import { getDb } from "../src/db/client.js";
import { shares } from "../src/db/schema.js";
import worker from "../src/index.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { ctx, fakeAssets } from "./assets-stub.js";
import { login } from "./helpers.js";

const assets = fakeAssets({
  "/index.html": {
    body: "<!doctype html><html><head><title>x</title></head><body></body></html>",
    type: "text/html",
  },
  "/assets/app-abc.js": { body: "/*app*/", type: "text/javascript" },
}).fetcher;

const call = (
  host: string,
  path: string,
  headers: Record<string, string>,
  extra: object,
) =>
  worker.fetch(
    new Request(`http://${host}${path}`, { headers }) as Request<
      unknown,
      IncomingRequestCfProperties
    >,
    { ...(env as object), ASSETS: assets, ...extra } as never,
    ctx,
  );

const ids: Record<"public" | "team" | "private", string> = {
  public: "",
  team: "",
  private: "",
};
const who: Record<string, string | null> = { anonymous: null };

beforeAll(async () => {
  const tag = newId().slice(0, 6).toLowerCase();
  const o = await login(`nsb-owner-${tag}@x.com`);
  const owner = (await getUser(env, o.userId)) as Member;
  for (const v of ["public", "team", "private"] as const)
    ids[v] = (
      await publish(
        env,
        owner,
        {
          title: `NoSandbox ${v}`,
          visibility: v,
          format: "markdown",
          content: "x",
        } as never,
        null,
        undefined,
        "create",
      )
    ).id;
  const guestEmail = `nsb-guest-${tag}@x.com`;
  await getDb(env).insert(shares).values({
    artifactId: ids.private,
    email: guestEmail,
    role: "viewer",
    createdBy: o.userId,
    createdAt: Date.now(),
  });
  who.owner = o.cookie;
  who.member = (await login(`nsb-member-${tag}@x.com`)).cookie;
  who.nonMember = (await login(`nsb-other-${tag}@x.com`)).cookie;
  who.guest = (await login(guestEmail, "guest")).cookie;
});

const HEADERS: Record<string, Record<string, string>> = {
  plain: {},
  iframe: { "sec-fetch-dest": "iframe" },
  embed: { "x-oa-embed": "1" },
  both: { "sec-fetch-dest": "iframe", "x-oa-embed": "1" },
};
const ENVS: Record<string, object> = {
  unset: { EMBED_ORIGINS: "" },
  set: { EMBED_ORIGINS: "https://open-artifacts.com https://b.example.com" },
};

function paths(): string[] {
  const out = [
    "/",
    "/assets/app-abc.js",
    "/api/v1/me",
    "/oauth/authorize",
    "/sign-in",
  ];
  for (const id of Object.values(ids))
    out.push(viewerPath(id), `${viewerPath(id)}/full`, `${viewerPath(id)}/v/1`);
  return out;
}

describe("app host never sends a CSP sandbox", () => {
  for (const [envName, extra] of Object.entries(ENVS))
    it(`EMBED_ORIGINS ${envName}`, async () => {
      let n = 0;
      for (const [person, cookie] of Object.entries(who))
        for (const [hName, h] of Object.entries(HEADERS))
          for (const p of paths()) {
            const headers = { ...h, ...(cookie ? { cookie } : {}) };
            const r = await call("app.localhost", p, headers, extra);
            await r.body?.cancel();
            const csp = r.headers.get("content-security-policy") ?? "";
            expect(
              csp.toLowerCase(),
              `GET ${p} as ${person}, headers=${hName}, EMBED_ORIGINS ${envName} (status ${r.status})`,
            ).not.toContain("sandbox");
            n++;
          }
      expect(n).toBe(5 * 4 * 14);
    });
});

describe("content host contrast", () => {
  it("does carry the sandbox", async () => {
    for (const [hName, h] of Object.entries(HEADERS)) {
      const r = await call(
        "content.localhost",
        `${publicPrefix(ids.public, 1)}__view`,
        h,
        { ASSETS: fakeAssets().fetcher },
      );
      await r.body?.cancel();
      expect(r.headers.get("content-security-policy"), hName).toMatch(
        /^sandbox /,
      );
    }
  });
});
