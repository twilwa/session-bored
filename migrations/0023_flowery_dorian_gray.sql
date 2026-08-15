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
UPDATE `file` SET `deleted_at` = CAST(strftime('%s','now') AS INTEGER) * 1000, `updated_at` = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE `deleted_at` is null AND `task_id` is not null AND EXISTS (SELECT 1 FROM `file` AS `newer` WHERE `newer`.`task_id` = `file`.`task_id` AND `newer`.`speaker_id` = `file`.`speaker_id` AND `newer`.`deleted_at` is null AND (`newer`.`created_at` > `file`.`created_at` OR (`newer`.`created_at` = `file`.`created_at` AND `newer`.`id` > `file`.`id`)));--> statement-breakpoint
CREATE UNIQUE INDEX `file_task_speaker_live_unique` ON `file` (`task_id`,`speaker_id`) WHERE "file"."deleted_at" is null and "file"."task_id" is not null;
