CREATE TABLE `submission_author_access` (
	`submission_id` text PRIMARY KEY NOT NULL,
	`author_key_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `submission_author_key_unique` ON `submission_author_access` (`author_key_hash`);--> statement-breakpoint
CREATE INDEX `submission_author_updated_idx` ON `submission_author_access` (`updated_at`);