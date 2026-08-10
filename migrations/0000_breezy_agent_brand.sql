CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_account_user_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_account_provider_unique` ON `account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `auth_session_user_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `comment` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_id` text,
	`file_id` text,
	`parent_id` text,
	`author_user_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`submission_id`) REFERENCES `submission`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `comment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "comment_single_subject_check" CHECK(("comment"."submission_id" is not null and "comment"."file_id" is null) or ("comment"."submission_id" is null and "comment"."file_id" is not null))
);
--> statement-breakpoint
CREATE INDEX `comment_submission_idx` ON `comment` (`submission_id`);--> statement-breakpoint
CREATE INDEX `comment_file_idx` ON `comment` (`file_id`);--> statement-breakpoint
CREATE TABLE `email_dispatch` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`template_key` text,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`recipients` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`provider_message_ids` text,
	`sent_at` integer,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `email_dispatch_event_status_idx` ON `email_dispatch` (`event_id`,`status`);--> statement-breakpoint
CREATE TABLE `embed` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`widget_type` text NOT NULL,
	`name` text NOT NULL,
	`config` text,
	`public_token` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `embed_public_token_unique` ON `embed` (`public_token`);--> statement-breakpoint
CREATE TABLE `event` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`tagline` text,
	`description` text,
	`start_date` text,
	`end_date` text,
	`venue` text,
	`timezone` text DEFAULT 'America/Los_Angeles' NOT NULL,
	`branding` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_slug_unique` ON `event` (`slug`);--> statement-breakpoint
CREATE TABLE `file_version` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`version` integer NOT NULL,
	`storage_key` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`checksum` text,
	`latest` integer DEFAULT true NOT NULL,
	`uploaded_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_version_number_unique` ON `file_version` (`file_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `file_version_storage_key_unique` ON `file_version` (`storage_key`);--> statement-breakpoint
CREATE TABLE `file` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`task_id` text,
	`session_id` text,
	`speaker_id` text,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `program_session`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`speaker_id`) REFERENCES `speaker`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `file_event_idx` ON `file` (`event_id`);--> statement-breakpoint
CREATE TABLE `form_field` (
	`id` text PRIMARY KEY NOT NULL,
	`form_id` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`description` text,
	`field_type` text NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`options` text,
	`conditional_field_id` text,
	`conditional_operator` text,
	`conditional_value` text,
	`validation` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`form_id`) REFERENCES `form`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conditional_field_id`) REFERENCES `form_field`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `form_field_key_unique` ON `form_field` (`form_id`,`key`);--> statement-breakpoint
CREATE TABLE `format` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`duration_minutes` integer,
	`description` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `format_event_name_unique` ON `format` (`event_id`,`name`);--> statement-breakpoint
CREATE TABLE `form` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`public_slug` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`open_at` integer,
	`close_at` integer,
	`welcome_copy` text,
	`confirmation_copy` text,
	`confirmation_email_copy` text,
	`minimum_speakers` integer DEFAULT 1 NOT NULL,
	`maximum_speakers` integer,
	`published_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "form_minimum_speakers_check" CHECK("form"."minimum_speakers" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `form_public_slug_unique` ON `form` (`public_slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `form_event_name_version_unique` ON `form` (`event_id`,`name`,`version`);--> statement-breakpoint
CREATE TABLE `person` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`job_title` text,
	`organization` text,
	`bio` text,
	`headshot_url` text,
	`twitter` text,
	`linkedin` text,
	`social_links` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `person_email_unique` ON `person` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `person_user_unique` ON `person` (`user_id`);--> statement-breakpoint
CREATE TABLE `review_assignment` (
	`id` text PRIMARY KEY NOT NULL,
	`round_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`reviewer_user_id` text NOT NULL,
	`status` text DEFAULT 'assigned' NOT NULL,
	`assigned_at` integer NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`round_id`) REFERENCES `review_round`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`submission_id`) REFERENCES `submission`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_assignment_unique` ON `review_assignment` (`round_id`,`submission_id`,`reviewer_user_id`);--> statement-breakpoint
CREATE INDEX `review_assignment_reviewer_idx` ON `review_assignment` (`reviewer_user_id`,`status`);--> statement-breakpoint
CREATE TABLE `review_round` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`opens_at` integer,
	`closes_at` integer,
	`anonymized` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_round_event_name_unique` ON `review_round` (`event_id`,`name`);--> statement-breakpoint
CREATE TABLE `reviewer_round_pool` (
	`id` text PRIMARY KEY NOT NULL,
	`round_id` text NOT NULL,
	`reviewer_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`round_id`) REFERENCES `review_round`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviewer_round_pool_unique` ON `reviewer_round_pool` (`round_id`,`reviewer_user_id`);--> statement-breakpoint
CREATE TABLE `reviewer_track` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`reviewer_user_id` text NOT NULL,
	`track_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`track_id`) REFERENCES `track`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviewer_track_unique` ON `reviewer_track` (`reviewer_user_id`,`track_id`);--> statement-breakpoint
CREATE TABLE `review` (
	`id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`author_user_id` text NOT NULL,
	`scores` text,
	`comment` text,
	`aggregate_score` real,
	`submitted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`assignment_id`) REFERENCES `review_assignment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_assignment_unique_review` ON `review` (`assignment_id`);--> statement-breakpoint
CREATE TABLE `room` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`capacity` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_event_name_unique` ON `room` (`event_id`,`name`);--> statement-breakpoint
CREATE TABLE `scorecard_criterion` (
	`id` text PRIMARY KEY NOT NULL,
	`round_id` text NOT NULL,
	`label` text NOT NULL,
	`description` text,
	`criterion_type` text NOT NULL,
	`options` text,
	`weight` real,
	`required` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`round_id`) REFERENCES `review_round`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `criterion_round_label_unique` ON `scorecard_criterion` (`round_id`,`label`);--> statement-breakpoint
CREATE TABLE `session_speaker` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`speaker_id` text NOT NULL,
	`role_label` text DEFAULT 'speaker' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `program_session`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`speaker_id`) REFERENCES `speaker`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_speaker_unique` ON `session_speaker` (`session_id`,`speaker_id`);--> statement-breakpoint
CREATE TABLE `program_session` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`submission_id` text,
	`track_id` text,
	`format_id` text,
	`room_id` text,
	`title` text,
	`abstract` text,
	`content_status` text DEFAULT 'draft' NOT NULL,
	`schedule_status` text DEFAULT 'unplaced' NOT NULL,
	`scheduled_date` text,
	`starts_at` integer,
	`ends_at` integer,
	`direct_entry` integer DEFAULT false NOT NULL,
	`ics_uid` text NOT NULL,
	`published_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`submission_id`) REFERENCES `submission`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`track_id`) REFERENCES `track`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`format_id`) REFERENCES `format`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`room_id`) REFERENCES `room`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "session_content_status_check" CHECK("program_session"."content_status" in ('draft','in_review','approved')),
	CONSTRAINT "session_schedule_status_check" CHECK("program_session"."schedule_status" in ('unplaced','tbd','placed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_ics_uid_unique` ON `program_session` (`ics_uid`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_submission_unique` ON `program_session` (`submission_id`);--> statement-breakpoint
CREATE TABLE `speaker` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`event_id` text NOT NULL,
	`status` text DEFAULT 'invited' NOT NULL,
	`custom_fields` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "speaker_status_check" CHECK("speaker"."status" in ('invited','confirmed','pending_employer_approval','onboarding','ready','withdrawn'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `speaker_person_event_unique` ON `speaker` (`person_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `submission_speaker` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_id` text NOT NULL,
	`person_id` text NOT NULL,
	`role_label` text DEFAULT 'speaker' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`submission_id`) REFERENCES `submission`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `submission_speaker_unique` ON `submission_speaker` (`submission_id`,`person_id`);--> statement-breakpoint
CREATE TABLE `submission_track` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_id` text NOT NULL,
	`track_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`submission_id`) REFERENCES `submission`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`track_id`) REFERENCES `track`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `submission_track_unique` ON `submission_track` (`submission_id`,`track_id`);--> statement-breakpoint
CREATE TABLE `submission_value` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_id` text NOT NULL,
	`field_id` text NOT NULL,
	`value` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`submission_id`) REFERENCES `submission`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `form_field`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `submission_value_field_unique` ON `submission_value` (`submission_id`,`field_id`);--> statement-breakpoint
CREATE TABLE `submission` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`form_id` text NOT NULL,
	`form_version` integer NOT NULL,
	`submitter_person_id` text NOT NULL,
	`format_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`is_draft` integer DEFAULT true NOT NULL,
	`title` text,
	`abstract` text,
	`title_at_time` text,
	`org_at_time` text,
	`audience_level` text,
	`notes_for_reviewers` text,
	`submitted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`form_id`) REFERENCES `form`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`submitter_person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`format_id`) REFERENCES `format`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "submission_status_check" CHECK("submission"."status" in ('draft','submitted','under_review','accepted','maybe','declined','withdrawn'))
);
--> statement-breakpoint
CREATE INDEX `submission_event_status_idx` ON `submission` (`event_id`,`status`);--> statement-breakpoint
CREATE INDEX `submission_submitter_idx` ON `submission` (`submitter_person_id`);--> statement-breakpoint
CREATE TABLE `system_state` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `system_state_key_unique` ON `system_state` (`key`);--> statement-breakpoint
CREATE TABLE `task_assignee` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`speaker_id` text NOT NULL,
	`status` text DEFAULT 'assigned' NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`speaker_id`) REFERENCES `speaker`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_assignee_unique` ON `task_assignee` (`task_id`,`speaker_id`);--> statement-breakpoint
CREATE TABLE `task` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`session_id` text,
	`task_type` text DEFAULT 'general' NOT NULL,
	`title` text NOT NULL,
	`instructions` text,
	`due_at` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`accepted_file_types` text,
	`maximum_file_bytes` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `program_session`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_event_status_idx` ON `task` (`event_id`,`status`);--> statement-breakpoint
CREATE TABLE `track` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`color` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `track_event_name_unique` ON `track` (`event_id`,`name`);--> statement-breakpoint
CREATE INDEX `track_event_idx` ON `track` (`event_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`role` text DEFAULT 'speaker' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "user_role_check" CHECK("user"."role" in ('organizer','reviewer','speaker'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);