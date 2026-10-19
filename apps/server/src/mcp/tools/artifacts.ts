import type { McpServer } from "@modelcontextprotocol/server";
import {
  type ArtifactSummary,
  CreateUploadInputSchema,
  GetArtifactInputSchema,
  type GetArtifactResult,
  IdInputSchema,
  ListQuerySchema,
  PublishToolInputSchema,
  RestoreVersionInputSchema,
  SearchQuerySchema,
  SetVisibilityInputSchema,
  ShareArtifactInputSchema,
  UnshareInputSchema,
  viewerPath,
} from "@oa/shared";
import { publicPrefix, signContent } from "../../content/signing.js";
import type { Env } from "../../env.js";
import { ApiError, appOrigin, contentOrigin } from "../../http/errors.js";
import {
  getSummary,
  list,
  listVersions,
  patch,
  publish,
  readVersionFile,
  restoreVersion,
  softDelete,
} from "../../services/artifacts.js";
import { search } from "../../services/search.js";
import { deleteShare, putShare } from "../../services/shares.js";
import { createUpload } from "../../services/uploads.js";
import { guard, ok, type ToolEnv } from "../server.js";
import { describeTool } from "../tool-defs.js";

/** get_artifact inlines text files up to this size. */
export const INLINE_TEXT_BYTES = 1024 * 1024;

const TEXT_TYPE =
  /^(text\/|application\/(json|javascript|ecmascript|xml|x-yaml|yaml|toml|x-sh|sql|graphql)\b|image\/svg\+xml\b|[a-z]+\/[\w.-]+\+(json|xml)\b)/i;
export const isTextType = (ct: string) => TEXT_TYPE.test(ct);

const notFound = () => new ApiError("not_found", "Not found");
const viewUrl = (env: Env, id: string) => appOrigin(env) + viewerPath(id);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const more = (cursor: string | null) => (cursor ? " (more: pass cursor)" : "");

/** Content-host URL for one file: public prefix, else a signed 10-minute prefix. */
async function downloadUrl(
  env: Env,
  a: ArtifactSummary,
  v: number,
  path: string,
): Promise<string> {
  const prefix =
    a.visibility === "public"
      ? publicPrefix(a.id, v)
      : (await signContent(env, a.id, v)).prefix;
  const p = path.split("/").map(encodeURIComponent).join("/");
  return `${contentOrigin(env)}${prefix}${p}`;
}

export function registerArtifactTools(server: McpServer, t: ToolEnv): void {
  const { env, user, caller } = t;

  server.registerTool(
    "publish_artifact",
    {
      description: describeTool("publish_artifact"),
      inputSchema: PublishToolInputSchema,
    },
    (input) =>
      guard(async () => {
        const r = await publish(env, user, input, t.agentNow(), t.exec, "any");
        return ok(
          `Published ${input.title ? `"${input.title}" ` : ""}${r.id} v${r.version}: ${r.url}`,
          r,
        );
      }),
  );

  server.registerTool(
    "create_upload",
    {
      description: describeTool("create_upload"),
      inputSchema: CreateUploadInputSchema,
    },
    (input) =>
      guard(async () => {
        const r = await createUpload(env, user, input);
        return ok(
          `Upload ${r.uploadId} reserved for artifact ${r.artifactId}: PUT the bytes to ${r.url} before ${r.expiresAt}`,
          r,
        );
      }),
  );

  server.registerTool(
    "get_artifact",
    {
      description: describeTool("get_artifact"),
      inputSchema: GetArtifactInputSchema,
    },
    (input) =>
      guard(async () => {
        const artifact = await getSummary(env, caller, input.id);
        const v = input.version ?? artifact.currentVersion;
        const [version] = await listVersions(env, caller, input.id, v + 1);
        if (!version || version.version !== v) throw notFound();
        const path = input.path ?? version.entry;
        const file = version.files.find((f) => f.path === path);
        if (!file) throw notFound();
        const out: GetArtifactResult = { artifact, version };
        if (
          input.includeContent &&
          isTextType(file.contentType) &&
          file.size <= INLINE_TEXT_BYTES
        ) {
          const { body } = await readVersionFile(
            env,
            caller,
            input.id,
            v,
            path,
          );
          out.content = await body.text();
        } else {
          out.downloadUrl = await downloadUrl(env, artifact, v, path);
        }
        const what =
          out.content !== undefined
            ? `${path} inline`
            : `${path} at downloadUrl (10 min)`;
        return ok(
          `"${artifact.title}" ${artifact.format} v${v}, ${what}: ${viewUrl(env, artifact.id)}`,
          out,
        );
      }),
  );

  server.registerTool(
    "list_artifacts",
    {
      description: describeTool("list_artifacts"),
      inputSchema: ListQuerySchema,
    },
    (input) =>
      guard(async () => {
        const page = await list(env, caller, input);
        return ok(
          `${plural(page.items.length, "artifact")}${more(page.nextCursor)}: ${appOrigin(env)}/`,
          page,
        );
      }),
  );

  server.registerTool(
    "search_artifacts",
    {
      description: describeTool("search_artifacts"),
      inputSchema: SearchQuerySchema,
    },
    (input) =>
      guard(async () => {
        const page = await search(
          env,
          caller,
          input.q,
          input.cursor,
          input.limit,
        );
        return ok(
          `${plural(page.items.length, "match")}${more(page.nextCursor)}: ${appOrigin(env)}/search?q=${encodeURIComponent(input.q)}`,
          page,
        );
      }),
  );

  server.registerTool(
    "list_versions",
    {
      description: describeTool("list_versions"),
      inputSchema: IdInputSchema,
    },
    (input) =>
      guard(async () => {
        const items = await listVersions(env, caller, input.id);
        return ok(
          `${plural(items.length, "version")} of ${input.id}: ${viewUrl(env, input.id)}`,
          { items },
        );
      }),
  );

  server.registerTool(
    "restore_version",
    {
      description: describeTool("restore_version"),
      inputSchema: RestoreVersionInputSchema,
    },
    (input) =>
      guard(async () => {
        const r = await restoreVersion(
          env,
          user,
          input.id,
          input.version,
          t.agentNow(),
          t.exec,
        );
        return ok(
          `Restored v${input.version} of ${r.id} as v${r.version}: ${r.url}`,
          r,
        );
      }),
  );

  server.registerTool(
    "share_artifact",
    {
      description: describeTool("share_artifact"),
      inputSchema: ShareArtifactInputSchema,
    },
    (input) =>
      guard(async () => {
        const s = await putShare(env, user, input.id, input);
        return ok(
          `Shared ${input.id} with ${s.email} as ${s.role}: ${viewUrl(env, input.id)}. ${
            s.emailed ? `Emailed ${s.email} a link.` : "No email sent."
          }`,
          s,
        );
      }),
  );

  server.registerTool(
    "unshare_artifact",
    {
      description: describeTool("unshare_artifact"),
      inputSchema: UnshareInputSchema,
    },
    (input) =>
      guard(async () => {
        await deleteShare(env, user, input.id, input.email);
        return ok(
          `Removed ${input.email}'s share of ${input.id}: ${viewUrl(env, input.id)}`,
          { id: input.id, email: input.email, removed: true },
        );
      }),
  );

  server.registerTool(
    "set_visibility",
    {
      description: describeTool("set_visibility"),
      inputSchema: SetVisibilityInputSchema,
    },
    (input) =>
      guard(async () => {
        const a = await patch(env, user, input.id, {
          visibility: input.visibility,
        });
        return ok(`${a.id} is now ${a.visibility}: ${viewUrl(env, a.id)}`, a);
      }),
  );

  server.registerTool(
    "delete_artifact",
    {
      description: describeTool("delete_artifact"),
      inputSchema: IdInputSchema,
    },
    (input) =>
      guard(async () => {
        await softDelete(env, user, input.id);
        return ok(
          `Deleted ${input.id}; restore it from the dashboard within 30 days: ${appOrigin(env)}/`,
          { id: input.id, deleted: true },
        );
      }),
  );
}
