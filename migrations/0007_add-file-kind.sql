PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_file` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`task_id` text,
	`session_id` text,
	`speaker_id` text,
	`kind` text DEFAULT 'deliverable' NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `program_session`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`speaker_id`) REFERENCES `speaker`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "file_kind_check" CHECK("__new_file"."kind" in ('headshot','deliverable'))
);
--> statement-breakpoint
INSERT INTO `__new_file`("id", "event_id", "task_id", "session_id", "speaker_id", "kind", "display_name", "created_at", "updated_at", "deleted_at") SELECT "id", "event_id", "task_id", "session_id", "speaker_id", 'deliverable', "display_name", "created_at", "updated_at", "deleted_at" FROM `file`;--> statement-breakpoint
DROP TABLE `file`;--> statement-breakpoint
ALTER TABLE `__new_file` RENAME TO `file`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `file_event_idx` ON `file` (`event_id`);--> statement-breakpoint
CREATE INDEX `file_speaker_kind_idx` ON `file` (`speaker_id`,`kind`);