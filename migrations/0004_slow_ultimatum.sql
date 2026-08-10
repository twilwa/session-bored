CREATE TABLE `task_scope` (
	`task_id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade
);
