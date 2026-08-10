ALTER TABLE `file` ADD `kind` text DEFAULT 'deliverable' NOT NULL CHECK("file"."kind" in ('headshot','deliverable'));--> statement-breakpoint
CREATE INDEX `file_speaker_kind_idx` ON `file` (`speaker_id`,`kind`);
