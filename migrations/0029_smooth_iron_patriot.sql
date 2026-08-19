ALTER TABLE `agent_credential` ADD `role_grant_id` text REFERENCES role_grant(id);
--> statement-breakpoint
UPDATE `agent_credential`
SET `revoked_at` = unixepoch() * 1000
WHERE `role_grant_id` IS NULL AND `revoked_at` IS NULL;
