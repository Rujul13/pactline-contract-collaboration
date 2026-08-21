CREATE TABLE `notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`recipient_email` text NOT NULL,
	`template_name` text NOT NULL,
	`template_payload` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`last_error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_notification_deliveries_status_next` ON `notification_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`portal_account_id` text,
	`notification_type` text NOT NULL,
	`unsubscribed` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`portal_account_id`) REFERENCES `portal_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notification_pref_user_type` ON `notification_preferences` (`user_id`,`notification_type`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notification_pref_portal_type` ON `notification_preferences` (`portal_account_id`,`notification_type`);