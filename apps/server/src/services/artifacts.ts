import {
  type AgentRef,
  type Member,
  newId,
  type PublishInput,
  type PublishResult,
  viewerPath,
} from "@oa/shared";
import { requireAccess } from "../auth/authz.js";
import type { Env } from "../env.js";
import { ApiError, appOrigin } from "../http/errors.js";
import { materialize, planFiles } from "./manifest.js";
import { getSettings } from "./members.js";
import { indexVersion } from "./search.js";

type Ctx = Pick<ExecutionContext, "waitUntil">;
const CAPS = { db: false, viewer: false, storage: false };

const later = async (ctx: Ctx | undefined, p: Promise<unknown>) => {
  const safe = p.catch((e) => console.error(e));
  if (ctx) ctx.waitUntil(safe);
  else await safe;
};

/**
 * - `create` (POST R.artifacts): no id, or a reserved id of this user's; any other id → 400.
 * - `version` (POST R.versions): the artifact must exist (editor+), else 404.
 * - `any` (MCP): either, by whether the id names an existing artifact.
 */
export type PublishMode = "create" | "version" | "any";

/**
 * Creates an artifact or adds a version (editor+; sharing fields owner-only).
 * Everything happens in one D1 batch (a transaction). The version number comes
 * from `UPDATE … current_version + 1 … RETURNING` and the versions
 * `INSERT … SELECT` reads it, so concurrent publishes never collide. Every
 * statement carries the same guard (artifact live, and all n listed uploads
 * still unconsumed, evaluated before the consume statement), so a lost race
 * writes nothing: 404 if the artifact is gone, 409 if an upload was used.
 */
export async function publish(
  env: Env,
  user: Member,
  input: PublishInput,
  agent: AgentRef | null,
  ctx?: Ctx,
  mode: PublishMode = "any",
): Promise<PublishResult> {
  const plan = planFiles(input);
  const db = env.DB;
  const now = Date.now();
  const notFound = () => new ApiError("not_found", "Not found");
  let id: string;
  let create = true;
  let reserved = false;
  let capabilities = CAPS;
  if (input.id === undefined) {
    if (mode === "version") throw notFound();
    id = newId();
  } else {
    id = input.id;
    const exists =
      mode === "create"
        ? null
        : await db
            .prepare("select 1 from artifacts where id = ?")
            .bind(id)
            .first();
    if (exists) {
      const a = await requireAccess(env, { kind: "user", user }, id, "editor");
      create = false;
      const sharing =
        input.visibility !== undefined ||
        input.capabilities !== undefined ||
        input.allowAnonymousWrites !== undefined;
      if (sharing && a.ownerId !== user.id)
        throw new ApiError("bad_request", "only the owner can change sharing");
      capabilities = { ...CAPS, ...(JSON.parse(a.capabilities) as object) };
    } else {
      if (mode === "version") throw notFound();
      const r = await db
        .prepare(
          "select 1 from reserved_artifacts where id = ? and user_id = ?",
        )
        .bind(id, user.id)
        .first();
      if (!r) {
        if (mode === "create")
          throw new ApiError(
            "bad_request",
            "use POST /versions to publish a new version",
            { path: "id", reason: "not_reserved" },
          );
        throw notFound();
      }
      reserved = true;
    }
  }
  if (create && input.title === undefined)
    throw new ApiError(
      "bad_request",
      "title is required when creating an artifact",
      {
        path: "title",
        reason: "missing",
      },
    );
  const caps = JSON.stringify({ ...capabilities, ...input.capabilities });
  const visibility =
    input.visibility ??
    (create ? (await getSettings(env)).defaultVisibility : undefined);

  const { manifest, written, uploadIds } = await materialize(
    env,
    id,
    user.id,
    plan,
  );

  // Uploads guard: all listed uploads still unconsumed (uncorrelated subquery).
  const n = uploadIds.length;
  const ids = JSON.stringify(uploadIds);
  const guard = n
    ? " and (select count(*) from uploads where id in (select value from json_each(?)) and consumed = 0) = ?"
    : "";
  const guardArgs = n ? [ids, n] : [];

  const stmts: D1PreparedStatement[] = [];
  if (create) {
    stmts.push(
      db
        .prepare(
          `insert into artifacts (id, owner_id, title, description, format, visibility,
             current_version, capabilities, allow_anonymous_writes, created_at, updated_at)
           select ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ? where 1${guard}`,
        )
        .bind(
          id,
          user.id,
          input.title,
          input.description ?? null,
          plan.format,
          visibility,
          caps,
          input.allowAnonymousWrites ? 1 : 0,
          now,
          now,
          ...guardArgs,
        ),
    );
    if (reserved)
      stmts.push(
        db
          .prepare(
            `delete from reserved_artifacts where id = ? and user_id = ?
               and exists (select 1 from artifacts where id = ?)`,
          )
          .bind(id, user.id, id),
      );
  }
  const sets = [
    "current_version = current_version + 1",
    "updated_at = ?",
    "last_agent_name = ?",
    "last_agent_version = ?",
    "format = ?",
  ];
  const vals: unknown[] = [
    now,
    agent?.name ?? null,
    agent?.version ?? null,
    plan.format,
  ];
  if (!create) {
    const opt: [string, unknown][] = [
      ["title", input.title],
      ["description", input.description],
      ["visibility", input.visibility],
      ["capabilities", input.capabilities && caps],
      [
        "allow_anonymous_writes",
        input.allowAnonymousWrites === undefined
          ? undefined
          : input.allowAnonymousWrites
            ? 1
            : 0,
      ],
    ];
    for (const [col, v] of opt)
      if (v !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(v);
      }
  }
  const bump = stmts.length;
  stmts.push(
    db
      .prepare(
        `update artifacts set ${sets.join(", ")}
         where id = ? and deleted_at is null${guard} returning current_version`,
      )
      .bind(...vals, id, ...guardArgs),
    db
      .prepare(
        `insert into versions (artifact_id, version, entry, manifest, language, message,
           agent_name, agent_version, created_by, created_at)
         select id, current_version, ?, ?, ?, ?, ?, ?, ?, ? from artifacts
         where id = ? and deleted_at is null${guard}`,
      )
      .bind(
        plan.entry,
        JSON.stringify(manifest),
        plan.language,
        input.message ?? null,
        agent?.name ?? null,
        agent?.version ?? null,
        user.id,
        now,
        id,
        ...guardArgs,
      ),
  );
  // Last: the guard above still sees every listed upload unconsumed.
  if (n)
    stmts.push(
      db
        .prepare(
          `update uploads set consumed = 1
           where id in (select value from json_each(?)) and consumed = 0
             and exists (select 1 from artifacts where id = ? and deleted_at is null)${guard}`,
        )
        .bind(ids, id, ...guardArgs),
    );

  const cleanup = () =>
    written.length ? later(ctx, env.FILES.delete(written)) : undefined;
  let version: number | undefined;
  try {
    const res = await db.batch<{ current_version: number }>(stmts);
    version = res[bump]?.results[0]?.current_version;
  } catch (e) {
    await cleanup();
    if (
      String((e as Error)?.message).includes(
        "UNIQUE constraint failed: artifacts.id",
      )
    )
      throw new ApiError("conflict", "Artifact already exists");
    throw e;
  }
  if (version === undefined) {
    await cleanup();
    const live = await db
      .prepare("select 1 from artifacts where id = ? and deleted_at is null")
      .bind(id)
      .first();
    if (live || (create && n))
      throw new ApiError("conflict", "An upload was already used");
    throw notFound();
  }
  await later(ctx, indexVersion(env, id, version));
  return { id, version, url: appOrigin(env) + viewerPath(id) };
}
