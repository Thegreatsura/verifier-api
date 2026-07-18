export type WorkspaceTier = 'FREE' | 'PRO' | 'BUSINESS';
export type BillingTermMonths = 1 | 3 | 6 | 12;

import type { BillingConfig } from './billingConfig';

export const LEGACY_FREE_RATE_LIMIT = 30;

export function getWorkspacePlanKey(
  tier: WorkspaceTier,
  grandfathered: boolean,
): 'FREE' | 'FREE_GRANDFATHERED' | 'PRO' | 'BUSINESS' {
  return tier === 'FREE' && grandfathered ? 'FREE_GRANDFATHERED' : tier;
}

export function getVerificationMonthlyQuota(
  tier: WorkspaceTier,
  grandfathered: boolean,
  quotas: {
    freeQuotaNewMonthly: number;
    freeQuotaLegacyMonthly: number;
    proQuotaMonthly: number;
    businessQuotaMonthly: number;
  },
): number {
  const planKey = getWorkspacePlanKey(tier, grandfathered);
  if (planKey === 'FREE_GRANDFATHERED') return quotas.freeQuotaLegacyMonthly;
  if (planKey === 'FREE') return quotas.freeQuotaNewMonthly;
  if (planKey === 'PRO') return quotas.proQuotaMonthly;
  return quotas.businessQuotaMonthly;
}

export function getRateLimit(
  tier: WorkspaceTier,
  grandfathered: boolean,
  config: BillingConfig,
): number {
  if (tier === 'FREE' && grandfathered) return LEGACY_FREE_RATE_LIMIT;
  if (tier === 'FREE') return config.freeRateLimit;
  if (tier === 'PRO') return config.proRateLimit;
  return config.businessRateLimit;
}

export function getMonthlyImageCredits(tier: WorkspaceTier, config: BillingConfig): number {
  if (tier === 'FREE') return config.freeImageCredits;
  if (tier === 'PRO') return config.proImageCredits;
  return config.businessImageCredits;
}

export function getBatchMaxReferences(tier: WorkspaceTier, config: BillingConfig): number {
  if (tier === 'FREE') return config.freeBatchMaxReferences;
  if (tier === 'PRO') return config.proBatchMaxReferences;
  return config.businessBatchMaxReferences;
}

export function getWebhookLimit(tier: WorkspaceTier, config: BillingConfig): number {
  if (tier === 'FREE') return config.freeWebhookLimit;
  if (tier === 'PRO') return config.proWebhookLimit;
  return config.businessWebhookLimit;
}

export function getNotificationChannelLimit(tier: WorkspaceTier, config: BillingConfig): number {
  if (tier === 'FREE') return config.freeNotificationChannelLimit;
  if (tier === 'PRO') return config.proNotificationChannelLimit;
  return config.businessNotificationChannelLimit;
}

export function addMonths(from: Date, months: number): Date {
  const next = new Date(from);
  next.setMonth(next.getMonth() + months);
  return next;
}
