CREATE TABLE `speaker_directory_contact_tag` (
	`person_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`person_id`, `tag_id`),
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tag_id`) REFERENCES `speaker_directory_tag`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `speaker_directory_contact_tag_person_idx` ON `speaker_directory_contact_tag` (`person_id`);--> statement-breakpoint
CREATE INDEX `speaker_directory_contact_tag_tag_idx` ON `speaker_directory_contact_tag` (`tag_id`,`person_id`);--> statement-breakpoint
CREATE TABLE `speaker_directory_custom_field` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`value` text NOT NULL,
	`normalized_value` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `speaker_directory_custom_field_person_name_unique` ON `speaker_directory_custom_field` (`person_id`,`normalized_name`);--> statement-breakpoint
CREATE INDEX `speaker_directory_custom_field_filter_idx` ON `speaker_directory_custom_field` (`normalized_name`,`normalized_value`,`person_id`);--> statement-breakpoint
CREATE INDEX `speaker_directory_custom_field_person_idx` ON `speaker_directory_custom_field` (`person_id`);--> statement-breakpoint
CREATE TABLE `speaker_directory_tag` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `speaker_directory_tag_name_unique` ON `speaker_directory_tag` (`normalized_name`);