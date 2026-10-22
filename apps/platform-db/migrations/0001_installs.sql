-- Platform D1 (platformNames(env).db, oa-s-platform / oa-p-platform).
-- Install metadata only: no customer data lives here. Every install's own
-- data stays in its own D1, R2, KV and Durable Objects.
CREATE TABLE IF NOT EXISTS installs (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE,
  app_host TEXT UNIQUE,
  content_host TEXT UNIQUE,
  owner_email TEXT,
  d1_id TEXT,
  kv_id TEXT,
  version TEXT,
  previous_version TEXT,
  rl_ns INTEGER UNIQUE CHECK (rl_ns % 8 = 0),
  do_migration_tag TEXT,
  test_hooks INTEGER NOT NULL DEFAULT 0,
  inputs_hash TEXT NOT NULL,
  broker_kid TEXT,
  state TEXT CHECK (state IN ('creating', 'active', 'upgrading', 'deleting')),
  created_at INTEGER,
  updated_at INTEGER
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
