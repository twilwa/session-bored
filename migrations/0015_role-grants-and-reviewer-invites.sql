CREATE TABLE `role_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`source` text NOT NULL,
	`granted_by_user_id` text,
	`granted_at` integer NOT NULL,
	`note` text,
	`revoked_at` integer,
	`revoked_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "role_grant_role_check" CHECK("role_grant"."role" in ('organizer','reviewer','speaker')),
	CONSTRAINT "role_grant_source_check" CHECK("role_grant"."source" in ('backfill','organizer','acceptance','reviewer_invite'))
);
--> statement-breakpoint
CREATE INDEX `role_grant_user_idx` ON `role_grant` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `role_grant_live_unique` ON `role_grant` (`user_id`,`role`) WHERE "role_grant"."revoked_at" is null;--> statement-breakpoint
CREATE TABLE `reviewer_invite` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`event_id` text NOT NULL,
	`track_ids` text NOT NULL,
	`round_ids` text NOT NULL,
	`invited_by_user_id` text NOT NULL,
	`redeemed_at` integer,
	`redeemed_by_user_id` text,
	`revoked_at` integer,
	`revoked_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reviewer_invite_email_idx` ON `reviewer_invite` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `reviewer_invite_open_unique` ON `reviewer_invite` (`email`,`event_id`) WHERE "reviewer_invite"."redeemed_at" is null and "reviewer_invite"."revoked_at" is null;--> statement-breakpoint
-- Backfill, conservatively. An organizer or reviewer holds a role somebody set deliberately,
-- so it carries over as-is. A speaker row is minted at first CFP draft rather than at
-- acceptance, so `role = 'speaker'` alone is not evidence of presenting: only accounts that
-- actually own a live speaker record keep speaker access, and everyone else becomes an
-- attendee. Nobody who can reach the speaker portal today loses it, and the People surface
-- shows the evidence behind each grant so an organizer can revoke the over-grants by hand.
INSERT INTO `role_grant` (
	`id`, `user_id`, `role`, `source`, `granted_by_user_id`, `granted_at`, `note`,
	`created_at`, `updated_at`
)
SELECT
	'rgrant_' || lower(hex(randomblob(16))),
	`user`.`id`,
	`user`.`role`,
	'backfill',
	NULL,
	CAST(strftime('%s','now') AS INTEGER) * 1000,
	'Carried over from the role this account already held.',
	CAST(strftime('%s','now') AS INTEGER) * 1000,
	CAST(strftime('%s','now') AS INTEGER) * 1000
FROM `user`
WHERE `user`.`role` IN ('organizer','reviewer');--> statement-breakpoint
INSERT INTO `role_grant` (
	`id`, `user_id`, `role`, `source`, `granted_by_user_id`, `granted_at`, `note`,
	`created_at`, `updated_at`
)
SELECT
	'rgrant_' || lower(hex(randomblob(16))),
	`user`.`id`,
	'speaker',
	'backfill',
	NULL,
	CAST(strftime('%s','now') AS INTEGER) * 1000,
	'Carried over because this account already owned a speaker record.',
	CAST(strftime('%s','now') AS INTEGER) * 1000,
	CAST(strftime('%s','now') AS INTEGER) * 1000
FROM `user`
WHERE `user`.`role` = 'speaker'
	AND EXISTS (
		SELECT 1 FROM `person`
		JOIN `speaker` ON `speaker`.`person_id` = `person`.`id` AND `speaker`.`deleted_at` IS NULL
		WHERE `person`.`user_id` = `user`.`id`
	);
