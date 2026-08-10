PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_email_dispatch` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`template_key` text,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`recipients` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`provider_message_ids` text,
	`failure_reason` text,
	`sent_at` integer,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_email_dispatch`("id", "event_id", "template_key", "subject", "body", "recipients", "status", "provider_message_ids", "failure_reason", "sent_at", "created_by_user_id", "created_at", "updated_at", "deleted_at") SELECT "id", "event_id", "template_key", "subject", "body", "recipients", "status", "provider_message_ids", NULL, "sent_at", "created_by_user_id", "created_at", "updated_at", "deleted_at" FROM `email_dispatch`;--> statement-breakpoint
DROP TABLE `email_dispatch`;--> statement-breakpoint
ALTER TABLE `__new_email_dispatch` RENAME TO `email_dispatch`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `email_dispatch_event_status_idx` ON `email_dispatch` (`event_id`,`status`);--> statement-breakpoint
ALTER TABLE `program_session` ADD `ics_sequence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `decision_notice` ADD `sent_at` integer;--> statement-breakpoint
ALTER TABLE `decision_notice` ADD `provider_message_id` text;--> statement-breakpoint
ALTER TABLE `decision_notice` ADD `failure_reason` text;