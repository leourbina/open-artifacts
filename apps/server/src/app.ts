import { Hono } from "hono";
import { ApiError, errorJson, toErrorResponse } from "./http/errors.js";
import { type AppEnv, securityHeaders } from "./http/middleware.js";
import { type AppType, mountRoutes } from "./routes/index.js";

export const ROBOTS = "User-agent: *\nDisallow: /";

export const methodNotAllowed = () =>
  errorJson(405, "bad_request", "Method not allowed", undefined, {
    Allow: "GET, HEAD",
  });

// Paths owned by the Worker; never served by the SPA fallback.
// (/a/*, /no-access and /search are SPA routes and fall through to ASSETS.)
const WORKER_PREFIX = /^\/(api|auth|oauth|\.well-known|mcp)(\/|$)/;

// Decode, collapse slashes and resolve dot segments; null if malformed.
function normalizedPath(url: string): string | null {
  let p: string;
  try {
    p = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

export function createApp(mount: (app: AppType) => void = mountRoutes) {
  const app: AppType = new Hono<AppEnv>();
  app.use(securityHeaders({ frameDeny: true }));
  app.onError((e) => toErrorResponse(e));
  app.notFound(() => toErrorResponse(new ApiError("not_found", "Not found")));

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/robots.txt", (c) => c.text(ROBOTS));
  // Ordering: GET (and HEAD, which Hono routes to GET handlers) match above
  // first; app.all only catches the remaining methods.
  app.all("/healthz", methodNotAllowed);
  app.all("/robots.txt", methodNotAllowed);

  mount(app);

  // Final fallback (registered last, in one place): SPA from ASSETS for GET/HEAD non-Worker paths.
  // (Requires run_worker_first: true, so the Worker sees every request.)
  app.on(["GET", "HEAD"], "*", (c) => {
    const path = normalizedPath(c.req.url);
    if (path === null || WORKER_PREFIX.test(path) || !c.env.ASSETS) {
      return toErrorResponse(new ApiError("not_found", "Not found"));
    }
    return c.env.ASSETS.fetch(c.req.raw);
  });
  return app;
}

export const app = createApp();
