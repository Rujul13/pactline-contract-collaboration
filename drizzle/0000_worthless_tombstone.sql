CREATE TABLE `access_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`party_id` text NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`permission` text DEFAULT 'view' NOT NULL,
	`status` text DEFAULT 'invited' NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`password_changed_at` text,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`last_signed_in_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`party_id`) REFERENCES `parties`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_access_accounts_username` ON `access_accounts` (`username`);--> statement-breakpoint
CREATE INDEX `idx_access_accounts_contract_status` ON `access_accounts` (`contract_id`,`status`);--> statement-breakpoint
CREATE TABLE `agreements` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`party_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`agreed_by` text NOT NULL,
	`agreed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`party_id`) REFERENCES `parties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agreements_party_version` ON `agreements` (`contract_id`,`party_id`,`version_number`);--> statement-breakpoint
CREATE INDEX `idx_agreements_contract_version` ON `agreements` (`contract_id`,`version_number`);--> statement-breakpoint
CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`approver_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`comment` text,
	`resolved_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`approver_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_approval_requests_approver_status` ON `approval_requests` (`approver_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_approval_requests_contract` ON `approval_requests` (`contract_id`);--> statement-breakpoint
CREATE TABLE `audit_log_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_display` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`clause_id` text,
	`version_number` integer,
	`before_hash` text,
	`after_hash` text,
	`request_id` text NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_audit_log_contract_created` ON `audit_log_entries` (`contract_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_actor_created` ON `audit_log_entries` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `clauses` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`clause_key` text NOT NULL,
	`order_index` integer NOT NULL,
	`title` text NOT NULL,
	`current_text` text NOT NULL,
	`clause_type` text NOT NULL,
	`word_content_control_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_clauses_contract_key` ON `clauses` (`contract_id`,`clause_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_clauses_contract_order` ON `clauses` (`contract_id`,`order_index`);--> statement-breakpoint
CREATE TABLE `contract_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`created_by` text NOT NULL,
	`snapshot` text NOT NULL,
	`parent_version_id` text,
	`document_object_key` text,
	`document_sha256` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_contract_versions_number` ON `contract_versions` (`contract_id`,`version_number`);--> statement-breakpoint
CREATE INDEX `idx_contract_versions_created` ON `contract_versions` (`contract_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `contracts` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`initiator_id` text NOT NULL,
	`approver_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`template_id` text,
	`crm_record_id` text,
	`current_version` integer DEFAULT 1 NOT NULL,
	`locked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`initiator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approver_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_contracts_initiator_status` ON `contracts` (`initiator_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_contracts_approver_status` ON `contracts` (`approver_id`,`status`);--> statement-breakpoint
CREATE TABLE `document_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`object_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`scan_status` text DEFAULT 'pending' NOT NULL,
	`uploaded_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_document_objects_key` ON `document_objects` (`object_key`);--> statement-breakpoint
CREATE INDEX `idx_document_objects_contract` ON `document_objects` (`contract_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `parties` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`role` text NOT NULL,
	`name` text NOT NULL,
	`company` text NOT NULL,
	`email` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_parties_contract_role` ON `parties` (`contract_id`,`role`);--> statement-breakpoint
CREATE INDEX `idx_parties_email` ON `parties` (`email`);--> statement-breakpoint
CREATE TABLE `proposed_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`clause_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`proposed_by` text NOT NULL,
	`original_text` text NOT NULL,
	`proposed_text` text NOT NULL,
	`rationale` text NOT NULL,
	`request_text` text,
	`parent_change_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`resolved_at` text,
	`resolved_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`clause_id`) REFERENCES `clauses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_proposed_changes_queue` ON `proposed_changes` (`contract_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_proposed_changes_clause` ON `proposed_changes` (`clause_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`external_identity_id` text NOT NULL,
	`manager_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_external_identity` ON `users` (`external_identity_id`);