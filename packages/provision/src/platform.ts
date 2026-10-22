// Platform D1 (`platformNames(env).db`): install metadata and the append-only
// audit trail. Schema: apps/platform-db/migrations/0001_installs.sql. Holds no
// customer data and no secret; every write checks the env prefix first.
import { createHash } from "node:crypto";
import type { Cf } from "./cf.js";
import { assertOwnResource, type Env } from "./names.js";
import type { InstallId } from "./types.js";

export interface InstallRow {
  id: InstallId;
  slug: string;
  app_host: string;
  content_host: string;
  owner_email: string | null;
  d1_id: string | null;
  kv_id: string | null;
  version: string | null;
  previous_version: string | null;
  rl_ns: number;
  do_migration_tag: string | null;
  test_hooks: number;
  inputs_hash: string;
  broker_kid: string | null;
  state: "creating" | "active" | "upgrading" | "deleting" | "deleted";
  created_at: number | null;
  updated_at: number | null;
}

/** JSON with object keys sorted at every level. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(v);
}

/** sha256 of the canonical JSON of what a resume must not change. */
export function inputsHash(o: {
  ownerEmail: string;
  vars?: Record<string, string>;
  testHooks?: boolean;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        ownerEmail: o.ownerEmail,
        vars: o.vars ?? {},
        testHooks: o.testHooks === true,
      }),
    )
    .digest("hex");
}

/** First ratelimit namespace id per env; installs take blocks of 8 above it. */
export const RL_BASE: Record<Env, number> = {
  staging: 1_000_000,
  prod: 2_000_000,
};

const UPDATABLE = new Set([
  "d1_id",
  "kv_id",
  "version",
  "previous_version",
  "do_migration_tag",
  "broker_kid",
  "state",
]);

export class PlatformDb {
  constructor(
    private readonly cf: Cf,
    private readonly db: { id: string; name: string },
    private readonly env: Env,
    private readonly now: () => number,
  ) {}

  private async read(sql: string, params: unknown[]): Promise<InstallRow[]> {
    const r = await this.cf.d1Query(this.db.id, sql, params);
    return (r[0]?.results ?? []) as unknown as InstallRow[];
  }

  private async write(sql: string, params: unknown[]) {
    assertOwnResource(this.db.name, this.env);
    return this.cf.d1Query(this.db.id, sql, params);
  }

  async byId(id: string): Promise<InstallRow | undefined> {
    return (await this.read("SELECT * FROM installs WHERE id = ?1", [id]))[0];
  }

  async bySlug(slug: string): Promise<InstallRow | undefined> {
    return (
      await this.read("SELECT * FROM installs WHERE slug = ?1", [slug])
    )[0];
  }

  /**
   * Installs, in any state (deleted included), that hold any of these hosts
   * as app host, content host or in the hosts table.
   */
  async holdersOf(hosts: [string, string]): Promise<InstallRow[]> {
    return this.read(
      "SELECT * FROM installs WHERE app_host IN (?1, ?2) OR content_host IN (?1, ?2) OR id IN (SELECT install_id FROM hosts WHERE host IN (?1, ?2))",
      hosts,
    );
  }

  /**
   * One batch (all or nothing): the `creating` row with the next free block
   * of 8 ratelimit ids, both hosts, and the create.start audit row.
   */
  async insertCreating(r: {
    id: InstallId;
    slug: string;
    appHost: string;
    contentHost: string;
    ownerEmail: string;
    testHooks: boolean;
    inputsHash: string;
  }): Promise<InstallRow> {
    const base = RL_BASE[this.env];
    const now = this.now();
    assertOwnResource(this.db.name, this.env);
    await this.cf.d1Batch(this.db.id, [
      {
        sql: `INSERT INTO installs (id, slug, app_host, content_host, owner_email, inputs_hash, test_hooks, state, rl_ns, created_at, updated_at)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'creating', COALESCE(MAX(rl_ns) + 8, ?8), ?9, ?9
FROM installs WHERE rl_ns >= ?8 AND rl_ns < ?10`,
        params: [
          r.id,
          r.slug,
          r.appHost,
          r.contentHost,
          r.ownerEmail,
          r.inputsHash,
          r.testHooks ? 1 : 0,
          base,
          now,
          base + 1_000_000,
        ],
      },
      {
        sql: "INSERT INTO hosts (host, install_id) VALUES (?1, ?2)",
        params: [r.appHost, r.id],
      },
      {
        sql: "INSERT INTO hosts (host, install_id) VALUES (?1, ?2)",
        params: [r.contentHost, r.id],
      },
      {
        sql: "INSERT INTO hosted_audit (at, install_id, action, detail) VALUES (?1, ?2, 'create.start', ?3)",
        params: [now, r.id, canonicalJson({ slug: r.slug })],
      },
    ]);
    const row = await this.byId(r.id);
    if (!row) throw new Error(`install ${r.id}: row missing after insert`);
    if (row.rl_ns >= base + 1_000_000 || row.rl_ns % 8 !== 0)
      throw new Error(
        `install ${r.id}: ratelimit block ${row.rl_ns} is outside the ${this.env} range`,
      );
    return row;
  }

  async update(id: InstallId, fields: Partial<InstallRow>): Promise<void> {
    const keys = Object.keys(fields);
    for (const k of keys)
      if (!UPDATABLE.has(k)) throw new Error(`installs.${k} is not updatable`);
    if (keys.length === 0) return;
    const set = keys.map((k, i) => `${k} = ?${i + 1}`).join(", ");
    await this.write(
      `UPDATE installs SET ${set}, updated_at = ?${keys.length + 1} WHERE id = ?${keys.length + 2}`,
      [
        ...keys.map((k) => (fields as Record<string, unknown>)[k] ?? null),
        this.now(),
        id,
      ],
    );
  }

  /** Hosts rows held by another install (any state). */
  async hostsHeldByOthers(id: string, hosts: [string, string]) {
    const r = await this.cf.d1Query(
      this.db.id,
      "SELECT host, install_id FROM hosts WHERE host IN (?1, ?2) AND install_id <> ?3",
      [hosts[0], hosts[1], id],
    );
    return (r[0]?.results ?? []) as { host: string; install_id: string }[];
  }

  /**
   * One batch on resume: re-insert both hosts rows (INSERT OR IGNORE heals a
   * first batch that was not atomic) and the create.resume audit row.
   */
  async resume(r: {
    id: InstallId;
    slug: string;
    appHost: string;
    contentHost: string;
  }): Promise<void> {
    assertOwnResource(this.db.name, this.env);
    const now = this.now();
    await this.cf.d1Batch(this.db.id, [
      {
        sql: "INSERT OR IGNORE INTO hosts (host, install_id) VALUES (?1, ?2)",
        params: [r.appHost, r.id],
      },
      {
        sql: "INSERT OR IGNORE INTO hosts (host, install_id) VALUES (?1, ?2)",
        params: [r.contentHost, r.id],
      },
      {
        sql: "INSERT INTO hosted_audit (at, install_id, action, detail) VALUES (?1, ?2, 'create.resume', ?3)",
        params: [now, r.id, canonicalJson({ slug: r.slug })],
      },
    ]);
  }

  /** Appends an audit row; `detail` must never carry a secret or an email. */
  async audit(
    id: InstallId,
    action: string,
    detail: Record<string, string | number> = {},
  ): Promise<void> {
    await this.write(
      "INSERT INTO hosted_audit (at, install_id, action, detail) VALUES (?1, ?2, ?3, ?4)",
      [this.now(), id, action, canonicalJson(detail)],
    );
  }
}
