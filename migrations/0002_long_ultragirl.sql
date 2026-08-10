CREATE TABLE IF NOT EXISTS `decision_batch_item` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`recipient_name` text NOT NULL,
	`recipient_email` text NOT NULL,
	`outcome` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`dispatched_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `decision_batch_item_unique` ON `decision_batch_item` (`batch_id`,`submission_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `decision_batch_item_submission_idx` ON `decision_batch_item` (`submission_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `decision_batch` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_by_user_id` text NOT NULL,
	`dispatched_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `decision_batch_event_status_idx` ON `decision_batch` (`event_id`,`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `decision_notice` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`outcome` text NOT NULL,
	`recipient_name` text NOT NULL,
	`recipient_email` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`delivery_status` text DEFAULT 'queued' NOT NULL,
	`queued_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `decision_notice_submission_unique` ON `decision_notice` (`submission_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `decision_notice_batch_idx` ON `decision_notice` (`batch_id`);
