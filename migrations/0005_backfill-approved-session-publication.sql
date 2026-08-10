-- ABOUTME: Preserves the visibility of approved sessions that predate explicit agenda publishing.
-- ABOUTME: Uses the last recorded session timestamp as the historical publication marker.
UPDATE `program_session`
SET `published_at` = COALESCE(`updated_at`, `created_at`, unixepoch() * 1000)
WHERE `content_status` = 'approved'
  AND `published_at` IS NULL
  AND `deleted_at` IS NULL;
