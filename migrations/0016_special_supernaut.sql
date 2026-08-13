-- A queued decision letter can be retired so a corrected one can take its place. Cancelling
-- keeps the row: who cancelled it, when, and why stay on the record, and the letter stays
-- visible in Communications rather than vanishing. Making the uniqueness partial is what
-- releases the submission for a new letter while keeping dispatch once-only for the live one.
--
-- Generated statements for `role_grant` and `reviewer_invite` were removed: migration 0015 is
-- hand-written and carries no snapshot, so drizzle-kit diffed against 0014 and re-emitted two
-- tables that already exist. The 0016 snapshot records them, so later migrations will not.
ALTER TABLE `decision_notice` ADD `cancelled_at` integer;--> statement-breakpoint
ALTER TABLE `decision_notice` ADD `cancelled_by_user_id` text;--> statement-breakpoint
ALTER TABLE `decision_notice` ADD `cancellation_reason` text;--> statement-breakpoint
DROP INDEX `decision_notice_submission_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `decision_notice_submission_unique` ON `decision_notice` (`submission_id`) WHERE "decision_notice"."cancelled_at" is null;
