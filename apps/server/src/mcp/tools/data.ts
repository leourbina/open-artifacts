import type { McpServer } from "@modelcontextprotocol/server";
import {
  ArtifactDataDeleteInputSchema,
  ArtifactDataGetInputSchema,
  ArtifactDataListInputSchema,
  ArtifactDataQueryInputSchema,
  ArtifactDataSetInputSchema,
  ArtifactDataUpdateInputSchema,
} from "@oa/shared";
import { requireAccess } from "../../auth/authz.js";
import { ApiError } from "../../http/errors.js";
import {
  type RuntimeStub,
  runtimeCall,
  runtimeStub,
} from "../../runtime/do.js";
import { guard, ok, type ToolEnv } from "../server.js";
import { describeTool } from "../tool-defs.js";

/**
 * The artifact's runtime DO, after the access check: viewer+ to read, editor+ to
 * write (else 404). The owner may use the store whether or not the artifact
 * declares `db`; anyone else needs the capability (403 capability_denied, as on
 * the runtime routes, since access is already proven).
 */
async function store(
  t: ToolEnv,
  id: string,
  write: boolean,
): Promise<RuntimeStub> {
  const a = await requireAccess(
    t.env,
    t.caller,
    id,
    write ? "editor" : "viewer",
  );
  if (a.ownerId !== t.user.id) {
    const caps = JSON.parse(a.capabilities) as { db?: boolean };
    if (caps.db !== true)
      throw new ApiError(
        "capability_denied",
        "This artifact does not declare the db capability",
      );
  }
  return runtimeStub(t.env, id);
}

export function registerDataTools(server: McpServer, t: ToolEnv): void {
  const actor = `agent:${t.user.id}`;
  const where = (id: string, collection: string) =>
    `${id} collection "${collection}"`;

  server.registerTool(
    "artifact_data_get",
    {
      description: describeTool("artifact_data_get"),
      inputSchema: ArtifactDataGetInputSchema,
    },
    (i) =>
      guard(async () => {
        const s = await store(t, i.id, false);
        const doc = await runtimeCall(() => s.get(i.collection, i.docId));
        return ok(
          `${doc ? "Found" : "No"} document "${i.docId}" in ${where(i.id, i.collection)}`,
          { doc },
        );
      }),
  );

  server.registerTool(
    "artifact_data_list",
    {
      description: describeTool("artifact_data_list"),
      inputSchema: ArtifactDataListInputSchema,
    },
    (i) =>
      guard(async () => {
        const s = await store(t, i.id, false);
        const page = await runtimeCall(() =>
          s.list(i.collection, i.cursor, i.limit),
        );
        return ok(
          `${page.items.length} documents in ${where(i.id, i.collection)}${page.nextCursor ? " (more: pass cursor)" : ""}`,
          page,
        );
      }),
  );

  server.registerTool(
    "artifact_data_query",
    {
      description: describeTool("artifact_data_query"),
      inputSchema: ArtifactDataQueryInputSchema,
    },
    (i) =>
      guard(async () => {
        const s = await store(t, i.id, false);
        const page = await runtimeCall(() => s.query(i.collection, i.query));
        return ok(
          `${page.items.length} matching documents in ${where(i.id, i.collection)}${page.nextCursor ? " (more: pass cursor)" : ""}`,
          page,
        );
      }),
  );

  server.registerTool(
    "artifact_data_set",
    {
      description: describeTool("artifact_data_set"),
      inputSchema: ArtifactDataSetInputSchema,
    },
    (i) =>
      guard(async () => {
        const s = await store(t, i.id, true);
        const doc = await runtimeCall(() =>
          s.set(i.collection, i.docId, i.data, actor),
        );
        return ok(`Set "${i.docId}" in ${where(i.id, i.collection)}`, doc);
      }),
  );

  server.registerTool(
    "artifact_data_update",
    {
      description: describeTool("artifact_data_update"),
      inputSchema: ArtifactDataUpdateInputSchema,
    },
    (i) =>
      guard(async () => {
        const s = await store(t, i.id, true);
        const doc = await runtimeCall(() =>
          s.update(i.collection, i.docId, i.patch, actor),
        );
        return ok(`Updated "${i.docId}" in ${where(i.id, i.collection)}`, doc);
      }),
  );

  server.registerTool(
    "artifact_data_delete",
    {
      description: describeTool("artifact_data_delete"),
      inputSchema: ArtifactDataDeleteInputSchema,
    },
    (i) =>
      guard(async () => {
        const s = await store(t, i.id, true);
        await runtimeCall(() => s.delete(i.collection, i.docId, actor));
        return ok(`Deleted "${i.docId}" from ${where(i.id, i.collection)}`, {
          id: i.id,
          collection: i.collection,
          docId: i.docId,
          deleted: true,
        });
      }),
  );
}
