ALTER TABLE `session_speaker` ADD `published_at` integer;
--> statement-breakpoint
UPDATE `session_speaker`
SET `published_at` = (
  SELECT `program_session`.`published_at`
  FROM `program_session`
  WHERE `program_session`.`id` = `session_speaker`.`session_id`
)
WHERE EXISTS (
  SELECT 1
  FROM `program_session`
  WHERE `program_session`.`id` = `session_speaker`.`session_id`
    AND `program_session`.`published_at` IS NOT NULL
);
