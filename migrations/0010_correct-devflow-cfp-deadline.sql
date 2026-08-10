-- ABOUTME: Corrects the DevFlow CFP deadline to April 30 at 11:59 PM in the event timezone.
-- ABOUTME: Updates both the live form and its published version from the previously seeded UTC wall clock.
UPDATE `form`
SET `close_at` = 1809154799000
WHERE `public_slug` = 'devflow-conf-2027'
  AND `close_at` = 1809129599000;

UPDATE `form_version`
SET `close_at` = 1809154799000
WHERE `form_id` = 'frm_devflow_cfp_2027'
  AND `close_at` = 1809129599000;
