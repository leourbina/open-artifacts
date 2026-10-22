-- P2 direct sign-in (hosted M1). Hand-edited from the drizzle-kit output:
-- identities and login_codes are WITHOUT ROWID (composite text primary keys:
-- one b-tree, no extra rowid index per insert). users.status has no CHECK
-- (an ADD COLUMN check can't be added without a table rebuild); the app only
-- writes MemberStatus values.
CREATE TABLE `identities` (
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`tenant` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`provider`, `subject`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
--> statement-breakpoint
CREATE UNIQUE INDEX `identities_user_provider` ON `identities` (`user_id`,`provider`);--> statement-breakpoint
CREATE TABLE `login_codes` (
	`email_key` text NOT NULL,
	`request_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`email_key`, `request_id`)
) WITHOUT ROWID;
--> statement-breakpoint
ALTER TABLE `users` ADD `session_epoch` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `status` text DEFAULT 'active' NOT NULL;