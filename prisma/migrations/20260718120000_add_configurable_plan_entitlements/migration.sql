-- PlanPricingConfig remains the single source of truth for plan entitlements.
ALTER TABLE `PlanPricingConfig`
    MODIFY `businessQuotaMonthly` INTEGER NOT NULL DEFAULT 50000,
    ADD COLUMN `freeRateLimit` INTEGER NOT NULL DEFAULT 10,
    ADD COLUMN `proRateLimit` INTEGER NOT NULL DEFAULT 60,
    ADD COLUMN `businessRateLimit` INTEGER NOT NULL DEFAULT 300,
    ADD COLUMN `freeImageCredits` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `proImageCredits` INTEGER NOT NULL DEFAULT 100,
    ADD COLUMN `businessImageCredits` INTEGER NOT NULL DEFAULT 300,
    ADD COLUMN `freeBatchMaxReferences` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `proBatchMaxReferences` INTEGER NOT NULL DEFAULT 20,
    ADD COLUMN `businessBatchMaxReferences` INTEGER NOT NULL DEFAULT 100,
    ADD COLUMN `freeWebhookLimit` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `proWebhookLimit` INTEGER NOT NULL DEFAULT 20,
    ADD COLUMN `businessWebhookLimit` INTEGER NOT NULL DEFAULT 50,
    ADD COLUMN `freeNotificationChannelLimit` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `proNotificationChannelLimit` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `businessNotificationChannelLimit` INTEGER NOT NULL DEFAULT 20,
    ADD COLUMN `businessUnlimitedVerifications` BOOLEAN NOT NULL DEFAULT false;

-- Keep direct writers (including the UI) inside the same conservative bounds
-- as the API validation layer.
ALTER TABLE `PlanPricingConfig`
    ADD CONSTRAINT `PlanPricingConfig_quotas_nonnegative` CHECK (
        `freeQuotaNewMonthly` >= 0 AND
        `freeQuotaLegacyMonthly` >= 0 AND
        `proQuotaMonthly` >= 0 AND
        `businessQuotaMonthly` >= 0
    ),
    ADD CONSTRAINT `PlanPricingConfig_rates_positive` CHECK (
        `freeRateLimit` > 0 AND
        `proRateLimit` > 0 AND
        `businessRateLimit` > 0
    ),
    ADD CONSTRAINT `PlanPricingConfig_image_credits_nonnegative` CHECK (
        `freeImageCredits` >= 0 AND
        `proImageCredits` >= 0 AND
        `businessImageCredits` >= 0
    ),
    ADD CONSTRAINT `PlanPricingConfig_batch_limits_safe` CHECK (
        `freeBatchMaxReferences` BETWEEN 0 AND 500 AND
        `proBatchMaxReferences` BETWEEN 0 AND 500 AND
        `businessBatchMaxReferences` BETWEEN 0 AND 500
    ),
    ADD CONSTRAINT `PlanPricingConfig_webhook_limits_nonnegative` CHECK (
        `freeWebhookLimit` >= 0 AND
        `proWebhookLimit` >= 0 AND
        `businessWebhookLimit` >= 0
    ),
    ADD CONSTRAINT `PlanPricingConfig_notification_limits_nonnegative` CHECK (
        `freeNotificationChannelLimit` >= 0 AND
        `proNotificationChannelLimit` >= 0 AND
        `businessNotificationChannelLimit` >= 0
    ),
    ADD CONSTRAINT `PlanPricingConfig_unlimited_boolean` CHECK (
        `businessUnlimitedVerifications` IN (false, true)
    );
