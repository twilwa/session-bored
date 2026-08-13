-- Records which session's participant handoff created an onboarding assignment, so removing
-- somebody from that session takes back the work naming them gave and nothing else.
--
-- Existing rows are left null on purpose. Null reads as "this belongs to the person", which is
-- the non-destructive answer: an assignment already in the database might have been seeded,
-- handed over from the roster, or created by an acceptance, and nothing on the row says which.
-- Treating them all as the person's own means a removal after this migration can only ever
-- take back work it can prove it granted.
ALTER TABLE `task_assignee` ADD `granted_by_session_id` text REFERENCES `program_session`(`id`);
