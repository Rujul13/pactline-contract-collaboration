CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`supplier_organization_id` text,
	`contract_id` text,
	`document_id` text,
	`kind` text NOT NULL,
	`severity` text DEFAULT 'attention' NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`due_at` text,
	`status` text DEFAULT 'open' NOT NULL,
	`dedupe_key` text NOT NULL,
	`snoozed_until` text,
	`acknowledged_at` text,
	`resolved_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`supplier_organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `vault_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_alerts_dedupe` ON `alerts` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_alerts_org_status_due` ON `alerts` (`organization_id`,`status`,`due_at`);--> statement-breakpoint
CREATE TABLE `clause_modules` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`heading` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_clause_modules_organization_status` ON `clause_modules` (`organization_id`,`status`);--> statement-breakpoint
CREATE TABLE `compliance_requirements` (
	`id` text PRIMARY KEY NOT NULL,
	`relationship_id` text NOT NULL,
	`document_category` text NOT NULL,
	`required` integer DEFAULT true NOT NULL,
	`warning_days` integer DEFAULT 30 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`relationship_id`) REFERENCES `supplier_relationships`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_compliance_requirements_unique` ON `compliance_requirements` (`relationship_id`,`document_category`);--> statement-breakpoint
CREATE TABLE `contract_access_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`portal_account_id` text NOT NULL,
	`legacy_access_account_id` text,
	`permission` text DEFAULT 'view' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`portal_account_id`) REFERENCES `portal_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`legacy_access_account_id`) REFERENCES `access_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_contract_access_grants_unique` ON `contract_access_grants` (`contract_id`,`portal_account_id`);--> statement-breakpoint
CREATE INDEX `idx_contract_access_grants_account_status` ON `contract_access_grants` (`portal_account_id`,`status`);--> statement-breakpoint
CREATE TABLE `contract_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`contract_type` text NOT NULL,
	`object_key` text NOT NULL,
	`filename` text NOT NULL,
	`fields` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`version_number` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_contract_templates_organization_status` ON `contract_templates` (`organization_id`,`status`);--> statement-breakpoint
CREATE TABLE `extracted_clauses` (
	`id` text PRIMARY KEY NOT NULL,
	`extraction_run_id` text NOT NULL,
	`clause_type` text NOT NULL,
	`heading` text NOT NULL,
	`clause_text` text NOT NULL,
	`confidence` integer DEFAULT 0 NOT NULL,
	`source_reference` text,
	`review_status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`extraction_run_id`) REFERENCES `extraction_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_extracted_clauses_run_review` ON `extracted_clauses` (`extraction_run_id`,`review_status`);--> statement-breakpoint
CREATE INDEX `idx_extracted_clauses_type` ON `extracted_clauses` (`clause_type`);--> statement-breakpoint
CREATE TABLE `extracted_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`extraction_run_id` text NOT NULL,
	`field_key` text NOT NULL,
	`value` text NOT NULL,
	`confidence` integer DEFAULT 0 NOT NULL,
	`source_reference` text,
	`review_status` text DEFAULT 'pending' NOT NULL,
	`corrected_value` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`extraction_run_id`) REFERENCES `extraction_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_extracted_fields_run_key` ON `extracted_fields` (`extraction_run_id`,`field_key`);--> statement-breakpoint
CREATE INDEX `idx_extracted_fields_review` ON `extracted_fields` (`review_status`);--> statement-breakpoint
CREATE TABLE `extraction_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`document_version_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`model` text,
	`error` text,
	`completed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `vault_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_version_id`) REFERENCES `vault_document_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_extraction_runs_document_status` ON `extraction_runs` (`document_id`,`status`);--> statement-breakpoint
CREATE TABLE `organization_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'contract_manager' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_organization_memberships_unique` ON `organization_memberships` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_organization_memberships_user_status` ON `organization_memberships` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`timezone` text DEFAULT 'America/Indianapolis' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_organizations_kind_status` ON `organizations` (`kind`,`status`);--> statement-breakpoint
CREATE TABLE `portal_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`display_name` text NOT NULL,
	`email` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` text,
	`last_signed_in_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_portal_accounts_username` ON `portal_accounts` (`username`);--> statement-breakpoint
CREATE INDEX `idx_portal_accounts_organization_status` ON `portal_accounts` (`organization_id`,`status`);--> statement-breakpoint
CREATE TABLE `portal_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`portal_account_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`portal_account_id`) REFERENCES `portal_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_portal_sessions_token_hash` ON `portal_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_portal_sessions_account_active` ON `portal_sessions` (`portal_account_id`,`expires_at`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `search_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`document_id` text NOT NULL,
	`document_version` integer NOT NULL,
	`clause_id` text,
	`content` text NOT NULL,
	`vector_id` text,
	`index_status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `vault_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_search_chunks_org_status` ON `search_chunks` (`organization_id`,`index_status`);--> statement-breakpoint
CREATE INDEX `idx_search_chunks_document_version` ON `search_chunks` (`document_id`,`document_version`);--> statement-breakpoint
CREATE TABLE `supplier_relationships` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_organization_id` text NOT NULL,
	`supplier_organization_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`customer_organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`supplier_organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_supplier_relationships_unique` ON `supplier_relationships` (`customer_organization_id`,`supplier_organization_id`);--> statement-breakpoint
CREATE INDEX `idx_supplier_relationships_supplier_status` ON `supplier_relationships` (`supplier_organization_id`,`status`);--> statement-breakpoint
CREATE TABLE `vault_document_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`object_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`scan_status` text DEFAULT 'pending' NOT NULL,
	`uploaded_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `vault_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_vault_document_versions_number` ON `vault_document_versions` (`document_id`,`version_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_vault_document_versions_key` ON `vault_document_versions` (`object_key`);--> statement-breakpoint
CREATE TABLE `vault_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_organization_id` text NOT NULL,
	`supplier_organization_id` text,
	`linked_contract_id` text,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`visibility` text DEFAULT 'shared' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`effective_date` text,
	`expiration_date` text,
	`current_version` integer DEFAULT 1 NOT NULL,
	`extraction_status` text DEFAULT 'not_started' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`supplier_organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`linked_contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_vault_documents_owner_status` ON `vault_documents` (`owner_organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_vault_documents_supplier_status` ON `vault_documents` (`supplier_organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_vault_documents_expiration` ON `vault_documents` (`expiration_date`);--> statement-breakpoint
ALTER TABLE `contracts` ADD `owner_organization_id` text REFERENCES organizations(id);--> statement-breakpoint
ALTER TABLE `contracts` ADD `counterparty_organization_id` text REFERENCES organizations(id);--> statement-breakpoint
ALTER TABLE `contracts` ADD `origin` text DEFAULT 'direct_upload' NOT NULL;--> statement-breakpoint
ALTER TABLE `contracts` ADD `submitted_by_portal_account_id` text;--> statement-breakpoint
ALTER TABLE `contracts` ADD `effective_date` text;--> statement-breakpoint
ALTER TABLE `contracts` ADD `expiration_date` text;