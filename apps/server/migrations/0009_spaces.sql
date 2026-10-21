-- P3 spaces (hosted M1, T1). Hand-edited from the drizzle-kit output:
--   * every table and index is IF NOT EXISTS (upgrades are additive only);
--   * text-PK tables are WITHOUT ROWID (0008's precedent: one b-tree, no extra
--     rowid index entry per insert);
--   * the backfill, the two triggers and the partial artifacts index are
--     appended by hand, as the DSL cannot express them.
-- A personal space's id is its owner's user id, and the users_personal_space
-- trigger creates it on every users insert (invites and P2's admission
-- included), so an artifact always has a space from this migration on. The
-- backfill moves every existing artifact into its owner's personal space: no
-- access level changes on any install.
CREATE TABLE IF NOT EXISTS `spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`owner_user_id` text,
	`all_members_role` text,
	`public_links` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "spaces_kind_check" CHECK("kind" in ('personal', 'shared')),
	CONSTRAINT "spaces_all_members_role_check" CHECK("spaces"."all_members_role" is null or "spaces"."all_members_role" in ('viewer', 'editor', 'manager')),
	CONSTRAINT "spaces_public_links_check" CHECK("spaces"."public_links" in (0, 1))
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `space_members` (
	`space_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `user_id`, `source`),
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "space_members_role_check" CHECK("role" in ('viewer', 'editor', 'manager')),
	CONSTRAINT "space_members_source_check" CHECK("source" in ('manual', 'sync'))
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `space_members_user_idx` ON `space_members` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `group_mappings` (
	`space_id` text NOT NULL,
	`group_id` text NOT NULL,
	`group_email` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`space_id`, `group_id`),
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "group_mappings_role_check" CHECK("role" in ('viewer', 'editor', 'manager'))
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `restricted_groups` (
	`group_id` text PRIMARY KEY NOT NULL,
	`group_email` text NOT NULL
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `directory_groups` (
	`group_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`parent_ids` text DEFAULT '[]' NOT NULL,
	`gen` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "directory_groups_parent_ids_check" CHECK(json_valid("directory_groups"."parent_ids"))
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `directory_members` (
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`gen` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`group_id`, `user_id`),
	FOREIGN KEY (`group_id`) REFERENCES `directory_groups`(`group_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `directory_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`space_id` text,
	`detail` text DEFAULT '{}' NOT NULL
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_events_at_idx` ON `audit_events` (`at`);--> statement-breakpoint
ALTER TABLE `artifacts` ADD `space_id` text REFERENCES spaces(id);--> statement-breakpoint
ALTER TABLE `identities` ADD `directory_bound` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `restricted_manual` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `restricted_sync` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `spaces` (`id`, `kind`, `name`, `owner_user_id`, `public_links`, `created_at`)
SELECT `id`, 'personal',
       coalesce(nullif(`display_name`, ''), nullif(`name`, ''), `email`),
       `id`, 1, `created_at`
FROM `users`;--> statement-breakpoint
UPDATE `artifacts` SET `space_id` = `owner_id` WHERE `space_id` IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `artifacts_space_live_idx` ON `artifacts` (`space_id`) WHERE "artifacts"."deleted_at" is null;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `users_personal_space`
AFTER INSERT ON `users`
BEGIN
	INSERT OR IGNORE INTO `spaces` (`id`, `kind`, `name`, `owner_user_id`, `public_links`, `created_at`)
	VALUES (
		new.`id`, 'personal',
		coalesce(nullif(new.`display_name`, ''), nullif(new.`name`, ''), new.`email`),
		new.`id`, 1, new.`created_at`
	);
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `artifacts_space_required`
BEFORE INSERT ON `artifacts`
WHEN new.`space_id` IS NULL
BEGIN
	SELECT RAISE(ABORT, 'space_id required');
END;
