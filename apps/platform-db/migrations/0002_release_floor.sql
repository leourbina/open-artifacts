-- Cache of the highest signed release floor seq this env has accepted
-- (releases/floor.json in oa-<p>-releases, T3b). Only a cache: the
-- provisioning token can write D1, so the anchor is FLOOR_MIN_SEQ in
-- packages/provision/src/internal/gates.ts. Raised with MAX, never lowered.
CREATE TABLE IF NOT EXISTS release_floor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  floor_seq INTEGER NOT NULL CHECK (floor_seq >= 0)
);
