export type WorkspaceTier = 'FREE' | 'PRO' | 'BUSINESS';
export type BillingTermMonths = 1 | 3 | 6 | 12;

export const RATE_LIMITS: Record<string, number> = {
  FREE: 10,
  FREE_GRANDFATHERED: 30,
  PRO: 60,
  BUSINESS: 300,
};

export const IMAGE_CREDITS_MONTHLY: Record<WorkspaceTier, number> = {
  FREE: 0,
  PRO: 100,
  BUSINESS: 300,
};

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

export function getMonthlyImageCredits(tier: WorkspaceTier): number {
  return IMAGE_CREDITS_MONTHLY[tier] ?? 0;
}

export function addMonths(from: Date, months: number): Date {
  const next = new Date(from);
  next.setMonth(next.getMonth() + months);
  return next;
}
