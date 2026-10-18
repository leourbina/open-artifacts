import { R, UploadCreateInputSchema } from "@oa/shared";
import { requireUser } from "../auth/authz.js";
import { jsonBody } from "../http/body.js";
import { createUpload, putUpload } from "../services/uploads.js";
import type { AppType } from "./index.js";

/** Must equal R.upload(id); app.ts exempts PUT on it from session and CSRF. */
export const UPLOAD = "/api/v1/uploads/:uploadId";

export function mountUploads(app: AppType): void {
  app.post(R.uploads, async (c) => {
    const user = requireUser(c);
    const input = await jsonBody(c, UploadCreateInputSchema);
    return c.json(await createUpload(c.env, user, input), 201);
  });

  // Authorized by its signature alone.
  app.put(UPLOAD, async (c) => {
    await putUpload(
      c.env,
      c.req.param("uploadId"),
      c.req.query("exp") ?? "",
      c.req.query("sig") ?? "",
      c.req.raw,
    );
    return c.body(null, 204);
  });
}
