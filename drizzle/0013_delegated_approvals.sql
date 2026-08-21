CREATE TABLE `approval_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`delegated_approver_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`kind` text NOT NULL,
	`required` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decision_reason` text,
	`resolved_at` text,
	`assigned_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`delegated_approver_id`) REFERENCES `delegated_approvers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_approval_assignments_contract_version` ON `approval_assignments` (`contract_id`,`version_number`);--> statement-breakpoint
CREATE INDEX `idx_approval_assignments_approver_status` ON `approval_assignments` (`delegated_approver_id`,`status`);--> statement-breakpoint
CREATE TABLE `approval_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`delegated_approver_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`revoked_at` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`assignment_id`) REFERENCES `approval_assignments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`delegated_approver_id`) REFERENCES `delegated_approvers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_approval_invites_token_hash` ON `approval_invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_approval_invites_assignment_active` ON `approval_invites` (`assignment_id`,`expires_at`,`used_at`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `approver_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`delegated_approver_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_active_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revoked_at` text,
	`ip_hash` text,
	`user_agent_hash` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`delegated_approver_id`) REFERENCES `delegated_approvers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_approver_sessions_token_hash` ON `approver_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_approver_sessions_active` ON `approver_sessions` (`delegated_approver_id`,`expires_at`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `delegated_approvers` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`title_role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`last_signed_in_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_delegated_approvers_org_email` ON `delegated_approvers` (`organization_id`,`email`);--> statement-breakpoint
CREATE INDEX `idx_delegated_approvers_status` ON `delegated_approvers` (`status`);