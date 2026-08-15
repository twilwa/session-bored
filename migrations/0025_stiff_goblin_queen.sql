CREATE TABLE `speaker_directory_note` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`author_user_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `speaker_directory_note_person_idx` ON `speaker_directory_note` (`person_id`,`deleted_at`,`created_at`);