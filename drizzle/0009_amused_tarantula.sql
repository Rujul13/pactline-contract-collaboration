CREATE TABLE `contract_relationships` (
	`id` text PRIMARY KEY NOT NULL,
	`source_contract_id` text NOT NULL,
	`target_contract_id` text NOT NULL,
	`relationship_type` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`source_contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_contract_relationship_unique` ON `contract_relationships` (`source_contract_id`,`target_contract_id`,`relationship_type`);--> statement-breakpoint
CREATE INDEX `idx_contract_relationship_target` ON `contract_relationships` (`target_contract_id`);--> statement-breakpoint
CREATE TABLE `error_events` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`route` text NOT NULL,
	`method` text NOT NULL,
	`actor_scope` text NOT NULL,
	`contract_id` text,
	`severity` text DEFAULT 'error' NOT NULL,
	`message` text NOT NULL,
	`fingerprint` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`occurrence_count` integer DEFAULT 1 NOT NULL,
	`first_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_error_events_open` ON `error_events` (`resolved_at`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `idx_error_events_fingerprint` ON `error_events` (`fingerprint`);--> statement-breakpoint
CREATE TABLE `paragraph_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`block_id` text NOT NULL,
	`review_round_id` text,
	`parent_comment_id` text,
	`author_kind` text NOT NULL,
	`author_id` text NOT NULL,
	`author_display` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolved_by` text,
	`resolved_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`block_id`) REFERENCES `document_blocks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_round_id`) REFERENCES `review_rounds`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_paragraph_comments_block` ON `paragraph_comments` (`contract_id`,`block_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_paragraph_comments_status` ON `paragraph_comments` (`contract_id`,`status`);--> statement-breakpoint
CREATE TABLE `reminder_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`kind` text NOT NULL,
	`channel` text DEFAULT 'in_app' NOT NULL,
	`due_at` text NOT NULL,
	`recipient` text,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`provider_message_id` text,
	`last_error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_reminder_due_status` ON `reminder_schedules` (`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `idx_reminder_contract` ON `reminder_schedules` (`contract_id`,`kind`);--> statement-breakpoint
CREATE TABLE `review_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`round_number` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`deadline_at` text,
	`opened_by` text NOT NULL,
	`closed_by` text,
	`closed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_review_rounds_number` ON `review_rounds` (`contract_id`,`round_number`);--> statement-breakpoint
CREATE INDEX `idx_review_rounds_status_deadline` ON `review_rounds` (`contract_id`,`status`,`deadline_at`);--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `version_number` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `kind` text DEFAULT 'business' NOT NULL;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `required` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `decision_reason` text;--> statement-breakpoint
ALTER TABLE `contracts` ADD `lifecycle_stage` text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE `contracts` ADD `renewal_date` text;--> statement-breakpoint
ALTER TABLE `contracts` ADD `notice_period_days` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `contracts` ADD `responsible_owner_id` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `contracts` ADD `contract_value_minor` integer;--> statement-breakpoint
ALTER TABLE `contracts` ADD `currency` text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE `contracts` ADD `risk_level` text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE `contracts` ADD `review_deadline_at` text;--> statement-breakpoint
ALTER TABLE `contracts` ADD `executed_at` text;--> statement-breakpoint
ALTER TABLE `paragraph_proposals` ADD `review_round_id` text;--> statement-breakpoint
ALTER TABLE `paragraph_proposals` ADD `resolution_reason` text;--> statement-breakpoint
UPDATE `contracts` SET `responsible_owner_id`=`initiator_id`, `lifecycle_stage`=CASE WHEN `status`='locked' AND `expiration_date`<CURRENT_TIMESTAMP THEN 'expired' WHEN `status`='locked' THEN 'approved' WHEN `status` IN ('shared','negotiating') THEN 'external_review' WHEN `status`='approved' THEN 'approved' ELSE 'draft' END;--> statement-breakpoint
INSERT INTO `review_rounds` (`id`,`contract_id`,`round_number`,`status`,`deadline_at`,`opened_by`,`created_at`,`updated_at`)
SELECT 'initial-round-' || `id`,`id`,1,'open',`review_deadline_at`,`initiator_id`,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM `contracts` WHERE `status` IN ('shared','negotiating');
