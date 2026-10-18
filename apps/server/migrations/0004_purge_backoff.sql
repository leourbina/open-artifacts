ALTER TABLE `artifacts` ADD `purge_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `artifacts` ADD `purge_after` integer;