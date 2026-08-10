CREATE TABLE `form_version_field` (
	`id` text PRIMARY KEY NOT NULL,
	`form_version_id` text NOT NULL,
	`stable_field_id` text NOT NULL,
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
	FOREIGN KEY (`form_version_id`) REFERENCES `form_version`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stable_field_id`) REFERENCES `form_field`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conditional_field_id`) REFERENCES `form_version_field`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `form_version_field_key_unique` ON `form_version_field` (`form_version_id`,`key`);--> statement-breakpoint
CREATE INDEX `form_version_field_order_idx` ON `form_version_field` (`form_version_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `form_version` (
	`id` text PRIMARY KEY NOT NULL,
	`form_id` text NOT NULL,
	`version` integer NOT NULL,
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
	FOREIGN KEY (`form_id`) REFERENCES `form`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "form_version_minimum_speakers_check" CHECK("form_version"."minimum_speakers" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `form_version_number_unique` ON `form_version` (`form_id`,`version`);--> statement-breakpoint
CREATE INDEX `form_version_status_idx` ON `form_version` (`form_id`,`status`);--> statement-breakpoint
INSERT OR IGNORE INTO `form_version` (
	`id`, `form_id`, `version`, `status`, `open_at`, `close_at`, `welcome_copy`,
	`confirmation_copy`, `confirmation_email_copy`, `minimum_speakers`,
	`maximum_speakers`, `published_at`, `created_at`, `updated_at`
)
SELECT
	`id` || ':v' || `version`, `id`, `version`, `status`, `open_at`, `close_at`,
	`welcome_copy`, `confirmation_copy`, `confirmation_email_copy`, `minimum_speakers`,
	`maximum_speakers`, `published_at`, `created_at`, `updated_at`
FROM `form`;--> statement-breakpoint
INSERT OR IGNORE INTO `form_version_field` (
	`id`, `form_version_id`, `stable_field_id`, `key`, `label`, `description`,
	`field_type`, `required`, `sort_order`, `options`, `validation`, `created_at`, `updated_at`
)
SELECT
	`form_field`.`id`, `form`.`id` || ':v' || `form`.`version`, `form_field`.`id`,
	`form_field`.`key`, `form_field`.`label`, `form_field`.`description`,
	`form_field`.`field_type`, `form_field`.`required`, `form_field`.`sort_order`,
	`form_field`.`options`, `form_field`.`validation`, `form_field`.`created_at`,
	`form_field`.`updated_at`
FROM `form_field`
INNER JOIN `form` ON `form_field`.`form_id` = `form`.`id`;--> statement-breakpoint
UPDATE `form_version_field`
SET
	`conditional_field_id` = (
		SELECT `source`.`conditional_field_id`
		FROM `form_field` AS `source`
		WHERE `source`.`id` = `form_version_field`.`stable_field_id`
	),
	`conditional_operator` = (
		SELECT `source`.`conditional_operator`
		FROM `form_field` AS `source`
		WHERE `source`.`id` = `form_version_field`.`stable_field_id`
	),
	`conditional_value` = (
		SELECT `source`.`conditional_value`
		FROM `form_field` AS `source`
		WHERE `source`.`id` = `form_version_field`.`stable_field_id`
	);
