import { prisma } from '../utils/prisma';

export interface BillingConfig {
  proPriceMonthlyETB: number;
  businessPriceMonthlyETB: number;
  discount3MonthsPercent: number;
  discount6MonthsPercent: number;
  discount12MonthsPercent: number;
  freeQuotaNewMonthly: number;
  freeQuotaLegacyMonthly: number;
  proQuotaMonthly: number;
  businessQuotaMonthly: number;
}

export const DEFAULT_BILLING_CONFIG: BillingConfig = {
  proPriceMonthlyETB: Number(process.env.VERITAS_PRO_PRICE ?? 199),
  businessPriceMonthlyETB: Number(process.env.VERITAS_BUSINESS_PRICE ?? 499),
  discount3MonthsPercent: 10,
  discount6MonthsPercent: 18,
  discount12MonthsPercent: 30,
  freeQuotaNewMonthly: 100,
  freeQuotaLegacyMonthly: 250,
  proQuotaMonthly: 2000,
  businessQuotaMonthly: 10000,
};

export async function getBillingConfig(): Promise<BillingConfig> {
  const record = await prisma.planPricingConfig.findUnique({
    where: { id: 'default' },
    select: {
      proPriceMonthlyETB: true,
      businessPriceMonthlyETB: true,
      discount3MonthsPercent: true,
      discount6MonthsPercent: true,
      discount12MonthsPercent: true,
      freeQuotaNewMonthly: true,
      freeQuotaLegacyMonthly: true,
      proQuotaMonthly: true,
      businessQuotaMonthly: true,
    },
  });

  return record ?? DEFAULT_BILLING_CONFIG;
}
