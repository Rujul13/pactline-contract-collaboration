CREATE TABLE `access_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`access_account_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`ip_hash` text,
	`user_agent_hash` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`access_account_id`) REFERENCES `access_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_access_sessions_token_hash` ON `access_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_access_sessions_account_active` ON `access_sessions` (`access_account_id`,`expires_at`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `document_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`block_key` text NOT NULL,
	`order_index` integer NOT NULL,
	`kind` text DEFAULT 'body' NOT NULL,
	`current_text` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_document_blocks_contract_key` ON `document_blocks` (`contract_id`,`block_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_document_blocks_contract_order` ON `document_blocks` (`contract_id`,`order_index`);--> statement-breakpoint
CREATE TABLE `paragraph_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`block_id` text NOT NULL,
	`base_version` integer NOT NULL,
	`proposed_by_account_id` text NOT NULL,
	`original_text` text NOT NULL,
	`proposed_text` text NOT NULL,
	`rationale` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`resolved_at` text,
	`resolved_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`block_id`) REFERENCES `document_blocks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`proposed_by_account_id`) REFERENCES `access_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_paragraph_proposals_queue` ON `paragraph_proposals` (`contract_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_paragraph_proposals_block` ON `paragraph_proposals` (`block_id`,`created_at`);
--> statement-breakpoint
PRAGMA optimize;
