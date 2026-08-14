CREATE TABLE `directory_merge` (
	`id` text PRIMARY KEY NOT NULL,
	`kept_person_id` text NOT NULL,
	`merged_person_id` text NOT NULL,
	`merged_by_user_id` text NOT NULL,
	`reasons` text NOT NULL,
	`merged_profile` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`kept_person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merged_person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merged_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `directory_merge_merged_person_unique` ON `directory_merge` (`merged_person_id`);--> statement-breakpoint
CREATE INDEX `directory_merge_kept_person_idx` ON `directory_merge` (`kept_person_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `file_task_speaker_live_unique` ON `file` (`task_id`,`speaker_id`) WHERE "file"."deleted_at" is null and "file"."task_id" is not null;