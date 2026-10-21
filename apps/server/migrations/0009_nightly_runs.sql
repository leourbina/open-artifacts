-- Nonces for the signed nightly trigger (POST /__oa/nightly, hosted installs).
-- Hand-edited from the drizzle-kit output: IF NOT EXISTS and WITHOUT ROWID.
CREATE TABLE IF NOT EXISTS `nightly_runs` (
	`day` text NOT NULL,
	`nonce` text NOT NULL,
	PRIMARY KEY(`day`, `nonce`)
) WITHOUT ROWID;
