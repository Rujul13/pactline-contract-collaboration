CREATE TABLE `integration_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`destination` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`delivered_at` text,
	`last_error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_integration_outbox_delivery` ON `integration_outbox` (`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `idx_integration_outbox_contract` ON `integration_outbox` (`contract_id`,`created_at`);