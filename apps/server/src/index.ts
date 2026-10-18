const NOINDEX = { "X-Robots-Tag": "noindex, nofollow" };

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: NOINDEX });

export default {
  fetch(request: Request): Response {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/healthz") {
      return json({ ok: true });
    }
    if (request.method === "GET" && pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /", {
        headers: { ...NOINDEX, "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return json({ error: { code: "not_found", message: "Not found" } }, 404);
  },
};
