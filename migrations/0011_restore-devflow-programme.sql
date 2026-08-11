-- ABOUTME: Restores the two accepted DevFlow demo sessions through the approval and publication gates.
-- ABOUTME: Gives the known unplaced CI session a dated TBD slot so both sessions are publicly reachable.
UPDATE `program_session`
SET `content_status` = 'approved',
    `updated_at` = unixepoch() * 1000
WHERE `event_id` = 'evt_devflow_conf_2027'
  AND `submission_id` IN ('sub_ci_monorepo', 'sub_docs_retrieval')
  AND `deleted_at` IS NULL
  AND EXISTS (
    SELECT 1 FROM `submission`
    WHERE `submission`.`id` = `program_session`.`submission_id`
      AND `submission`.`status` = 'accepted'
  );

UPDATE `program_session`
SET `schedule_status` = 'tbd',
    `scheduled_date` = (
      SELECT `start_date` FROM `event`
      WHERE `event`.`id` = `program_session`.`event_id`
    ),
    `room_id` = NULL,
    `starts_at` = NULL,
    `ends_at` = NULL,
    `updated_at` = unixepoch() * 1000
WHERE `event_id` = 'evt_devflow_conf_2027'
  AND `submission_id` = 'sub_ci_monorepo'
  AND `schedule_status` = 'unplaced'
  AND `deleted_at` IS NULL
  AND EXISTS (
    SELECT 1 FROM `submission`
    WHERE `submission`.`id` = `program_session`.`submission_id`
      AND `submission`.`status` = 'accepted'
  );

UPDATE `program_session`
SET `published_at` = COALESCE(`published_at`, unixepoch() * 1000),
    `updated_at` = unixepoch() * 1000
WHERE `event_id` = 'evt_devflow_conf_2027'
  AND `submission_id` IN ('sub_ci_monorepo', 'sub_docs_retrieval')
  AND `content_status` = 'approved'
  AND `schedule_status` != 'unplaced'
  AND `deleted_at` IS NULL
  AND EXISTS (
    SELECT 1 FROM `submission`
    WHERE `submission`.`id` = `program_session`.`submission_id`
      AND `submission`.`status` = 'accepted'
  );
