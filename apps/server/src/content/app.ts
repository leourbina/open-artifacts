import { Hono } from "hono";
import { methodNotAllowed, ROBOTS } from "../app.js";
import type { Env } from "../env.js";
import { ApiError, toErrorResponse } from "../http/errors.js";
import { CONTENT_CSP, securityHeaders } from "../http/middleware.js";

// Stub until B10: robots.txt only; never sets cookies, never touches ASSETS.
export const contentApp = new Hono<{ Bindings: Env }>();
contentApp.use(securityHeaders({ csp: CONTENT_CSP }));
contentApp.onError((e) => toErrorResponse(e));
contentApp.notFound(() =>
  toErrorResponse(new ApiError("not_found", "Not found")),
);
contentApp.get("/robots.txt", (c) => c.text(ROBOTS));
// Ordering: after the GET route so only non-GET/HEAD methods land here.
contentApp.all("/robots.txt", methodNotAllowed);
