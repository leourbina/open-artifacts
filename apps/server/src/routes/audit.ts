import { R } from "@oa/shared";
import { requireUser } from "../auth/authz.js";
import { orgCan } from "../auth/policy.js";
import { ApiError } from "../http/errors.js";
import { AUDIT_PAGE_MAX, exportAudit, listAudit } from "../services/audit.js";
import type { AppType } from "./index.js";

const DEFAULT_LIMIT = 50;

/** 1..AUDIT_PAGE_MAX, default 50; anything else 400. */
function limitOf(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < 1 || n > AUDIT_PAGE_MAX)
    throw new ApiError("bad_request", "Invalid limit", {
      path: "limit",
      reason: "invalid",
    });
  return n;
}

// Org owners and admins only (audit.read); everyone else 404. The route
// policy gate enforces the same rule first; these checks keep the handler
// safe on its own.
export function mountAudit(app: AppType): void {
  app.get(R.audit, async (c) => {
    const user = requireUser(c);
    if (!orgCan(user, "audit.read"))
      throw new ApiError("not_found", "Not found");
    return c.json(
      await listAudit(
        c.env,
        c.req.query("cursor"),
        limitOf(c.req.query("limit")),
      ),
    );
  });

  app.get(R.auditExport, (c) => {
    const user = requireUser(c);
    if (!orgCan(user, "audit.read"))
      throw new ApiError("not_found", "Not found");
    return new Response(exportAudit(c.env), {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-disposition": 'attachment; filename="audit.ndjson"',
        "cache-control": "no-store",
      },
    });
  });
}
