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

-- The operation lock. create and every lifecycle operation take it with a compare-and-swap
-- on (state, lease_until) and clears it when it ends, so a second upgrade,
-- rollback, var change or delete is refused while one runs. A process that
-- dies holding it leaves lease_until in the past after the lease time.
ALTER TABLE installs ADD COLUMN lease TEXT;
ALTER TABLE installs ADD COLUMN lease_until INTEGER;

-- The install's current vars (canonical JSON, no secret): what upgrade and
-- rollback render with. install_versions.vars records what each version was
-- rendered from; a rollback keeps these, not those.
ALTER TABLE installs ADD COLUMN vars TEXT;

-- A session cut (epoch bump) still owed to the install's own D1 after google
-- was newly enabled: the id and the vars it was minted against (the base) are
-- written before the new vars go out. Right after any upload is accepted the
-- cut runs when the uploaded vars have google newly on relative to the base,
-- and is dropped otherwise; the install's D1 records the id with the bump.
ALTER TABLE installs ADD COLUMN session_cut TEXT;

-- Bumped on every write of the row (trigger below): an operation claims the
-- row only if it is unchanged since its pre-flight read it.
ALTER TABLE installs ADD COLUMN row_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE installs ADD COLUMN session_cut_base TEXT;

CREATE TRIGGER IF NOT EXISTS installs_row_version
AFTER UPDATE ON installs
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE installs SET row_version = OLD.row_version + 1 WHERE id = NEW.id;
END;
