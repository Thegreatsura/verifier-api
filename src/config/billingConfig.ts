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
  freeRateLimit: number;
  proRateLimit: number;
  businessRateLimit: number;
  freeImageCredits: number;
  proImageCredits: number;
  businessImageCredits: number;
  freeBatchMaxReferences: number;
  proBatchMaxReferences: number;
  businessBatchMaxReferences: number;
  freeWebhookLimit: number;
  proWebhookLimit: number;
  businessWebhookLimit: number;
  freeNotificationChannelLimit: number;
  proNotificationChannelLimit: number;
  businessNotificationChannelLimit: number;
  businessUnlimitedVerifications: boolean;
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
  businessQuotaMonthly: 50000,
  freeRateLimit: 10,
  proRateLimit: 60,
  businessRateLimit: 300,
  freeImageCredits: 0,
  proImageCredits: 100,
  businessImageCredits: 300,
  freeBatchMaxReferences: 0,
  proBatchMaxReferences: 20,
  businessBatchMaxReferences: 100,
  freeWebhookLimit: 0,
  proWebhookLimit: 20,
  businessWebhookLimit: 50,
  freeNotificationChannelLimit: 0,
  proNotificationChannelLimit: 0,
  businessNotificationChannelLimit: 20,
  businessUnlimitedVerifications: false,
};

const NON_NEGATIVE_INTEGER_FIELDS = [
  'freeQuotaNewMonthly',
  'freeQuotaLegacyMonthly',
  'proQuotaMonthly',
  'businessQuotaMonthly',
  'freeImageCredits',
  'proImageCredits',
  'businessImageCredits',
  'freeWebhookLimit',
  'proWebhookLimit',
  'businessWebhookLimit',
  'freeNotificationChannelLimit',
  'proNotificationChannelLimit',
  'businessNotificationChannelLimit',
] as const satisfies readonly (keyof BillingConfig)[];

const POSITIVE_INTEGER_FIELDS = [
  'proPriceMonthlyETB',
  'businessPriceMonthlyETB',
  'freeRateLimit',
  'proRateLimit',
  'businessRateLimit',
] as const satisfies readonly (keyof BillingConfig)[];

const BATCH_LIMIT_FIELDS = [
  'freeBatchMaxReferences',
  'proBatchMaxReferences',
  'businessBatchMaxReferences',
] as const satisfies readonly (keyof BillingConfig)[];

const DISCOUNT_FIELDS = [
  'discount3MonthsPercent',
  'discount6MonthsPercent',
  'discount12MonthsPercent',
] as const satisfies readonly (keyof BillingConfig)[];

const CONFIG_FIELDS = new Set<keyof BillingConfig>(Object.keys(DEFAULT_BILLING_CONFIG) as (keyof BillingConfig)[]);

export class BillingConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues.join(' '));
    this.name = 'BillingConfigValidationError';
  }
}

export function validateBillingConfigUpdate(input: unknown): Partial<BillingConfig> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BillingConfigValidationError(['Configuration must be an object.']);
  }

  const candidate = input as Record<string, unknown>;
  const issues: string[] = [];
  const update: Partial<BillingConfig> = {};

  for (const key of Object.keys(candidate)) {
    if (!CONFIG_FIELDS.has(key as keyof BillingConfig)) {
      issues.push(`Unknown configuration field: ${key}.`);
    }
  }

  const validateInteger = (field: keyof BillingConfig, minimum: number, maximum?: number): void => {
    if (!(field in candidate)) return;
    const value = candidate[field];
    if (!Number.isInteger(value) || (value as number) < minimum || (maximum !== undefined && (value as number) > maximum)) {
      const range = maximum === undefined ? `${minimum} or greater` : `between ${minimum} and ${maximum}`;
      issues.push(`${field} must be an integer ${range}.`);
      return;
    }
    (update as Record<string, unknown>)[field] = value;
  };

  for (const field of NON_NEGATIVE_INTEGER_FIELDS) validateInteger(field, 0);
  for (const field of POSITIVE_INTEGER_FIELDS) validateInteger(field, 1);
  for (const field of BATCH_LIMIT_FIELDS) validateInteger(field, 0, 500);
  for (const field of DISCOUNT_FIELDS) validateInteger(field, 0, 100);

  if ('businessUnlimitedVerifications' in candidate) {
    if (typeof candidate.businessUnlimitedVerifications !== 'boolean') {
      issues.push('businessUnlimitedVerifications must be an explicit Boolean.');
    } else {
      update.businessUnlimitedVerifications = candidate.businessUnlimitedVerifications;
    }
  }

  if (issues.length > 0) throw new BillingConfigValidationError(issues);
  return update;
}

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
      freeRateLimit: true,
      proRateLimit: true,
      businessRateLimit: true,
      freeImageCredits: true,
      proImageCredits: true,
      businessImageCredits: true,
      freeBatchMaxReferences: true,
      proBatchMaxReferences: true,
      businessBatchMaxReferences: true,
      freeWebhookLimit: true,
      proWebhookLimit: true,
      businessWebhookLimit: true,
      freeNotificationChannelLimit: true,
      proNotificationChannelLimit: true,
      businessNotificationChannelLimit: true,
      businessUnlimitedVerifications: true,
    },
  });

  return record ?? DEFAULT_BILLING_CONFIG;
}

export async function updateBillingConfig(input: unknown): Promise<BillingConfig> {
  const update = validateBillingConfigUpdate(input);
  if (Object.keys(update).length === 0) {
    throw new BillingConfigValidationError(['Provide at least one configuration field.']);
  }

  const record = await prisma.planPricingConfig.upsert({
    where: { id: 'default' },
    update,
    create: { id: 'default', ...DEFAULT_BILLING_CONFIG, ...update },
  });

  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...config } = record;
  return config;
}
