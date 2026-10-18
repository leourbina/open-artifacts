import { DurableObject } from "cloudflare:workers";

// Placeholder so the ARTIFACT_RUNTIME binding deploys; B1 replaces it.
export class ArtifactRuntime extends DurableObject {}

const NOINDEX = { "X-Robots-Tag": "noindex, nofollow" };

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: NOINDEX });

const ROUTES: Record<string, () => Response> = {
  "/healthz": () => json({ ok: true }),
  "/robots.txt": () =>
    new Response("User-agent: *\nDisallow: /", {
      headers: { ...NOINDEX, "Content-Type": "text/plain; charset=utf-8" },
    }),
};

export default {
  fetch(request: Request): Response {
    const { pathname } = new URL(request.url);
    const route = Object.hasOwn(ROUTES, pathname) ? ROUTES[pathname] : null;
    if (route) {
      if (request.method === "GET") return route();
      if (request.method === "HEAD") {
        return new Response(null, route());
      }
      return new Response(null, {
        status: 405,
        headers: { ...NOINDEX, Allow: "GET, HEAD" },
      });
    }
    return json({ error: { code: "not_found", message: "Not found" } }, 404);
  },
  // No-op until B1 wires the daily cron (17 3 * * *).
  scheduled(): void {},
};
