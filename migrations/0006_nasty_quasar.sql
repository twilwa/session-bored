CREATE TABLE IF NOT EXISTS `ai_score_suggestion` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_id` text NOT NULL,
	`form_version` integer NOT NULL,
	`content_fingerprint` text DEFAULT '' NOT NULL,
	`round_id` text NOT NULL,
	`visibility` text NOT NULL,
	`criteria_fingerprint` text NOT NULL,
	`scores` text NOT NULL,
	`reasoning` text NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ai_score_submission_round_criteria_unique` ON `ai_score_suggestion` (`submission_id`,`form_version`,`content_fingerprint`,`round_id`,`visibility`,`criteria_fingerprint`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ai_score_submission_round_idx` ON `ai_score_suggestion` (`submission_id`,`round_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ai_submission_summary` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_id` text NOT NULL,
	`form_version` integer NOT NULL,
	`content_fingerprint` text DEFAULT '' NOT NULL,
	`visibility` text NOT NULL,
	`summary` text NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ai_summary_submission_version_visibility_unique` ON `ai_submission_summary` (`submission_id`,`form_version`,`content_fingerprint`,`visibility`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ai_summary_submission_idx` ON `ai_submission_summary` (`submission_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `event_review_config` (
	`event_id` text PRIMARY KEY NOT NULL,
	`ai_assistance_enabled` integer DEFAULT false NOT NULL,
	`updated_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
