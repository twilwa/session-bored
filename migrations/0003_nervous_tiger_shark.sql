CREATE TABLE `ai_score_suggestion` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_id` text NOT NULL,
	`form_version` integer NOT NULL,
	`round_id` text NOT NULL,
	`visibility` text NOT NULL,
	`criteria_fingerprint` text NOT NULL,
	`scores` text NOT NULL,
	`reasoning` text NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_score_submission_round_criteria_unique` ON `ai_score_suggestion` (`submission_id`,`form_version`,`round_id`,`visibility`,`criteria_fingerprint`);--> statement-breakpoint
CREATE INDEX `ai_score_submission_round_idx` ON `ai_score_suggestion` (`submission_id`,`round_id`);--> statement-breakpoint
CREATE TABLE `ai_submission_summary` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_id` text NOT NULL,
	`form_version` integer NOT NULL,
	`visibility` text NOT NULL,
	`summary` text NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_summary_submission_version_visibility_unique` ON `ai_submission_summary` (`submission_id`,`form_version`,`visibility`);--> statement-breakpoint
CREATE INDEX `ai_summary_submission_idx` ON `ai_submission_summary` (`submission_id`);--> statement-breakpoint
CREATE TABLE `event_review_config` (
	`event_id` text PRIMARY KEY NOT NULL,
	`ai_assistance_enabled` integer DEFAULT false NOT NULL,
	`updated_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
