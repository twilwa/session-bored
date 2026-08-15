-- Records that a participation is deliberately withheld from the public site until an agenda
-- publish releases it. Only two doors write it: the participant handoff takes the hold when it
-- adds somebody to an already-published session, and the agenda publish clears it. A link's
-- publication is never stored -- it is the session's publication minus a hold.
--
-- Existing rows are left null on purpose, and null is already the correct answer for every one
-- of them: nothing in the database today is under a publication hold, and every live link on a
-- published session is already public. No backfill is needed or wanted -- a backfill here could
-- only invent a hold nobody took.
ALTER TABLE `session_speaker` ADD `publication_hold_at` integer;
