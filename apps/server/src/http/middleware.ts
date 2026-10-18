import type { MiddlewareHandler } from "hono";

export const CONTENT_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";

export const securityHeaders =
  (opts: { frameDeny?: boolean; csp?: string } = {}): MiddlewareHandler =>
  async (c, next) => {
    await next();
    // Responses from fetch()/Response.redirect() have immutable headers: re-wrap.
    c.res = new Response(c.res.body, c.res);
    const h = c.res.headers;
    h.set("X-Robots-Tag", "noindex, nofollow");
    h.set("X-Content-Type-Options", "nosniff");
    h.set("Referrer-Policy", "strict-origin-when-cross-origin");
    if (opts.frameDeny) h.set("X-Frame-Options", "DENY");
    if (opts.csp) h.set("Content-Security-Policy", opts.csp);
  };
