-- P1 Task 5: upgrade, rollback, var changes and delete.
--
-- Every successful upload stores the install's rendered upload metadata for
-- that version (bindings, compat, tags, assets config; never a secret value
-- and never an assets jwt: secrets stay on the script through keep_bindings),
-- the vars it was rendered from, and the Durable Object tag it reached.
-- rollback re-uploads exactly this metadata. One row per install and version;
-- a var change rewrites the row of the live version.
CREATE TABLE IF NOT EXISTS install_versions (
  install_id TEXT NOT NULL REFERENCES installs (id),
  version TEXT NOT NULL,
  vars TEXT NOT NULL,
  metadata TEXT NOT NULL,
  do_migration_tag TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (install_id, version)
);

-- The operation lock. A lifecycle operation takes it with a compare-and-swap
-- on (state, lease_until) and clears it when it ends, so a second upgrade,
-- rollback, var change or delete is refused while one runs. A process that
-- dies holding it leaves lease_until in the past after the lease time.
ALTER TABLE installs ADD COLUMN lease TEXT;
ALTER TABLE installs ADD COLUMN lease_until INTEGER;

-- A session cut (epoch bump) still owed to the install's own D1 after google
-- was newly enabled: the id is written before the new vars go out and cleared
-- after the bump, which the install's D1 records under the same id.
ALTER TABLE installs ADD COLUMN session_cut TEXT;
