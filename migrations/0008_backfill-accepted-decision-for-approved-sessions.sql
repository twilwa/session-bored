-- ABOUTME: Syncs a submission's decision to 'accepted' when its own session is already approved and published.
-- ABOUTME: The public session gate requires both; a session reaching that state implies the decision, so align it.
UPDATE `submission`
SET `status` = 'accepted'
WHERE `status` != 'accepted'
  AND `id` IN (
    SELECT `submission_id` FROM `program_session`
    WHERE `submission_id` IS NOT NULL
      AND `content_status` = 'approved'
      AND `published_at` IS NOT NULL
      AND `deleted_at` IS NULL
  );
