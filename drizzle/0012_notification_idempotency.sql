ALTER TABLE `notification_deliveries` ADD `idempotency_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notification_idempotency_key` ON `notification_deliveries` (`idempotency_key`);