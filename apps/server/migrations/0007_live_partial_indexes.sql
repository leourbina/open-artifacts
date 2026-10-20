-- #248: fewer D1 rows per publish. The non-partial owner/visibility indexes
-- duplicated the *_live partials and cost a billed row on every updated_at bump.
-- Hand-edited from the drizzle-kit output: create first, then drop, both
-- idempotent, so a populated DB always has an index for the trash listing.
CREATE INDEX IF NOT EXISTS `artifacts_owner_deleted_idx` ON `artifacts` (`owner_id`,`deleted_at`) WHERE "artifacts"."deleted_at" is not null;--> statement-breakpoint
DROP INDEX IF EXISTS `artifacts_owner_updated_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `artifacts_visibility_updated_idx`;
