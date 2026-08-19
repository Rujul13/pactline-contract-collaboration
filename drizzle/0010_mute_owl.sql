ALTER TABLE `paragraph_comments` ADD `resolution_reason` text;--> statement-breakpoint
ALTER TABLE `paragraph_comments` ADD `reopened_by` text;--> statement-breakpoint
ALTER TABLE `paragraph_comments` ADD `reopened_at` text;--> statement-breakpoint
CREATE INDEX `idx_paragraph_comments_parent` ON `paragraph_comments` (`parent_comment_id`);