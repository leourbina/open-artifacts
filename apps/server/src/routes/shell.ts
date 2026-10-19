import { isId, viewerPath } from "@oa/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { getDb } from "../db/client.js";
import { artifacts } from "../db/schema.js";
import type { Env } from "../env.js";
import { appOrigin } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import { getSettings } from "../services/members.js";
import type { AppType } from "./index.js";

const SITE = "Open Artifacts";
const VERSION_NUM = /^[1-9]\d{0,8}$/;

// Bidi controls, zero-width characters, word joiner/invisibles and BOM.
const INVISIBLE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
const clean = (s: string) => s.replace(INVISIBLE, "");

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

type Og = {
  title: string;
  description: string | null;
  url: string;
  image: string | null;
};

/** Public, live artifacts only; anything else (incl. a malformed id) is null. */
async function publicOg(
  env: Env,
  id: string,
  v: number | undefined,
): Promise<Og | null> {
  if (!isId(id)) return null;
  const a = (
    await getDb(env)
      .select({
        title: artifacts.title,
        description: artifacts.description,
        hasThumbnail: artifacts.hasThumbnail,
      })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, id),
          eq(artifacts.visibility, "public"),
          isNull(artifacts.deletedAt),
        ),
      )
      .limit(1)
  )[0];
  if (!a) return null;
  const origin = appOrigin(env);
  return {
    title: clean(a.title),
    description: a.description
      ? Array.from(clean(a.description)).slice(0, 300).join("")
      : null,
    url: origin + viewerPath(id, v),
    image: a.hasThumbnail ? `${origin}/api/v1/artifacts/${id}/thumbnail` : null,
  };
}

function metaTags(og: Og): string {
  const m = (p: string, v: string) =>
    `<meta property="${p}" content="${esc(v)}">`;
  return [
    m("og:title", og.title),
    og.description ? m("og:description", og.description) : "",
    m("og:type", "website"),
    m("og:url", og.url),
    og.image ? m("og:image", og.image) : "",
  ].join("");
}

/**
 * Shell contract for the dashboard: every SPA shell HTML response carries
 * `<meta name="oa-instance" content="<settings.name>">` in its <head> (omitted
 * if the settings read fails), so signed-out pages can show the instance name.
 */
export async function instanceMeta(env: Env): Promise<string> {
  try {
    const { name } = await getSettings(env);
    return `<meta name="oa-instance" content="${esc(name)}">`;
  } catch {
    return "";
  }
}

/** SPA fallback: injects the instance meta into an HTML shell response. */
export async function withInstanceMeta(
  env: Env,
  res: Response,
): Promise<Response> {
  if (!res.ok || !res.headers.get("content-type")?.startsWith("text/html"))
    return res;
  const meta = await instanceMeta(env);
  if (!meta) return res;
  const headers = new Headers(res.headers);
  // The body changed: the asset's length and validator no longer apply.
  headers.delete("content-length");
  headers.delete("etag");
  const body = new HTMLRewriter()
    .on("head", {
      element(e) {
        e.append(meta, { html: true });
      },
    })
    .transform(res).body;
  return new Response(body, { status: res.status, headers });
}

export function mountShell(app: AppType): void {
  const shell = async (c: Context<AppEnv>, id: string, v?: number) => {
    const [og, meta, index] = await Promise.all([
      publicOg(c.env, id, v),
      instanceMeta(c.env),
      c.env.ASSETS.fetch(new Request(new URL("/", c.req.url))),
    ]);
    if (!index.ok) return index;
    const rewritten = new HTMLRewriter()
      .on("title", {
        element(e) {
          e.setInnerContent(og ? `${og.title} · ${SITE}` : SITE);
        },
      })
      .on("head", {
        element(e) {
          e.append(meta + (og ? metaTags(og) : ""), { html: true });
        },
      })
      .transform(index);
    return new Response(rewritten.body, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  };
  app.get("/a/:id", (c) => shell(c, c.req.param("id")));
  app.get("/a/:id/v/:v", async (c, next) => {
    const v = c.req.param("v");
    if (!VERSION_NUM.test(v)) return next();
    return shell(c, c.req.param("id"), Number(v));
  });
}
