CREATE TABLE `agent_credential` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`secret_digest` text NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "agent_credential_role_check" CHECK("agent_credential"."role" in ('organizer','reviewer','speaker'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_credential_secret_unique` ON `agent_credential` (`secret_digest`);--> statement-breakpoint
CREATE INDEX `agent_credential_user_idx` ON `agent_credential` (`user_id`,`revoked_at`);