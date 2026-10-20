import type { McpServer } from "@modelcontextprotocol/server";
import { authorize } from "../../auth/authz.js";
import { ApiError } from "../../http/errors.js";
import {
  type RuntimeStub,
  runtimeCall,
  runtimeStub,
} from "../../runtime/do.js";
import { guard, ok, type ToolEnv } from "../server.js";
import { toolConfig } from "../tool-defs.js";

/**
 * The artifact's runtime DO, after the access check, as on the REST runtime
 * routes (spec §6.7): viewer+ reads and writes (else 404). The owner may use
 * the store whether or not the artifact declares `db` (B14); anyone else needs
 * the capability (403 capability_denied, since access is already proven).
 */
async function store(t: ToolEnv, id: string): Promise<RuntimeStub> {
  const { level, artifact: a } = await authorize(t.env, t.caller, id, "view");
  if (level !== "owner") {
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
  // Same actor as the user's REST writes: one rate bucket per user.
  const actor = `u:${t.user.id}`;
  const where = (id: string, collection: string) =>
    `${id} collection "${collection}"`;

  server.registerTool(
    "artifact_data_get",
    toolConfig("artifact_data_get"),
    (i) =>
      guard(async () => {
        const s = await store(t, i.id);
        const doc = await runtimeCall(() => s.get(i.collection, i.docId));
        return ok(
          `${doc ? "Found" : "No"} document "${i.docId}" in ${where(i.id, i.collection)}`,
          { doc },
        );
      }),
  );

  server.registerTool(
    "artifact_data_list",
    toolConfig("artifact_data_list"),
    (i) =>
      guard(async () => {
        const s = await store(t, i.id);
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
    toolConfig("artifact_data_query"),
    (i) =>
      guard(async () => {
        const s = await store(t, i.id);
        const page = await runtimeCall(() => s.query(i.collection, i.query));
        return ok(
          `${page.items.length} matching documents in ${where(i.id, i.collection)}${page.nextCursor ? " (more: pass cursor)" : ""}`,
          page,
        );
      }),
  );

  server.registerTool(
    "artifact_data_set",
    toolConfig("artifact_data_set"),
    (i) =>
      guard(async () => {
        const s = await store(t, i.id);
        const doc = await runtimeCall(() =>
          s.set(i.collection, i.docId, i.data, actor),
        );
        return ok(`Set "${i.docId}" in ${where(i.id, i.collection)}`, doc);
      }),
  );

  server.registerTool(
    "artifact_data_update",
    toolConfig("artifact_data_update"),
    (i) =>
      guard(async () => {
        const s = await store(t, i.id);
        const doc = await runtimeCall(() =>
          s.update(i.collection, i.docId, i.patch, actor),
        );
        return ok(`Updated "${i.docId}" in ${where(i.id, i.collection)}`, doc);
      }),
  );

  server.registerTool(
    "artifact_data_delete",
    toolConfig("artifact_data_delete"),
    (i) =>
      guard(async () => {
        const s = await store(t, i.id);
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
