-- Platform D1 (platformNames(env).db, oa-s-platform / oa-p-platform).
-- Install metadata only: no customer data lives here. Every install's own
-- data stays in its own D1, R2, KV and Durable Objects.
-- Rows are never deleted: `deleted` is terminal and keeps the slug, hosts and
-- broker origin held until an explicit purge (not part of create).
CREATE TABLE IF NOT EXISTS installs (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  app_host TEXT NOT NULL UNIQUE,
  content_host TEXT NOT NULL UNIQUE,
  owner_email TEXT NOT NULL,
  d1_id TEXT,
  kv_id TEXT,
  version TEXT,
  previous_version TEXT,
  rl_ns INTEGER NOT NULL UNIQUE CHECK (rl_ns % 8 = 0),
  do_migration_tag TEXT,
  test_hooks INTEGER NOT NULL DEFAULT 0 CHECK (test_hooks IN (0, 1)),
  inputs_hash TEXT NOT NULL,
  broker_kid TEXT,
  state TEXT NOT NULL CHECK (state IN ('creating', 'active', 'upgrading', 'deleting', 'deleted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (app_host <> content_host)
);

-- Every host (app or content) of every install, once: uniqueness across both
-- columns. Written in the same batch as the installs row.
CREATE TABLE IF NOT EXISTS hosts (
  host TEXT NOT NULL PRIMARY KEY,
  install_id TEXT NOT NULL REFERENCES installs (id)
);

-- Append-only audit trail of provisioner actions (never secrets or emails).
CREATE TABLE IF NOT EXISTS hosted_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  install_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);

CREATE TRIGGER IF NOT EXISTS hosted_audit_no_update
BEFORE UPDATE ON hosted_audit
BEGIN
  SELECT RAISE(ABORT, 'hosted_audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS hosted_audit_no_delete
BEFORE DELETE ON hosted_audit
BEGIN
  SELECT RAISE(ABORT, 'hosted_audit is append-only');
END;
