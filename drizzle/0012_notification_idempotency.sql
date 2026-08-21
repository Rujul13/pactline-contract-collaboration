ALTER TABLE `notification_deliveries` ADD COLUMN `idempotency_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notification_idempotency_key` ON `notification_deliveries` (`idempotency_key`) WHERE `idempotency_key` IS NOT NULL;
