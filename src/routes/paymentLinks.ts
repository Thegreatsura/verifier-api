/**
 * payment links router
 *
 * POST   /payment-links               PRO+ — create link
 * GET    /payment-links               PRO+ — list links
 * GET    /payment-links/:id           PRO+ — get single link
 * PATCH  /payment-links/:id           PRO+ — update link
 * DELETE /payment-links/:id           PRO+ — delete link
 * GET    /payment-links/:id/public    PUBLIC — hosted page payload
 * POST   /payment-links/:id/confirm   PUBLIC — buyer payment confirmation
 */

import { Prisma } from '@prisma/client';
import { Router, Request, Response } from 'express';
import { runSmartVerify } from '../services/verifyUniversal';
import { accountMatches, cbeAccountMatches, extractPaymentDetails, maskCbeAccount } from '../utils/paymentMatch';
import { sendBuyerPurchaseEmail } from '../utils/purchaseEmail';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';
import { emitWorkspaceEvent } from '../utils/workspaceEvents';
import { extractLegacyCbeUrlData, isNewCbeReference } from '../utils/cbeReference';

const router = Router();

const APP_URL = process.env.VERITAS_APP_URL ?? 'https://veritas.et';
const MAX_EXPIRES_MINUTES = 1440;
const VALID_PROVIDERS = ['telebirr', 'cbe', 'dashen', 'abyssinia', 'cbebirr', 'mpesa'] as const;

type AuthSource = 'DASHBOARD' | 'API_KEY';

function getAuthContext(req: Request): {
  workspaceId: string;
  creatorType: AuthSource;
  createdByKeyId: string | null;
} | null {
  const apiKeyData = (req as any).apiKeyData as { id: string; workspaceId: string } | null;
  const workspaceContext = (req as any).workspaceContext as {
    workspace: { id: string };
    source: 'dashboard' | 'api_key';
  } | null;

  if (workspaceContext?.source === 'dashboard') {
    return {
      workspaceId: workspaceContext.workspace.id,
      creatorType: 'DASHBOARD',
      createdByKeyId: null,
    };
  }

  if (apiKeyData) {
    return {
      workspaceId: apiKeyData.workspaceId,
      creatorType: 'API_KEY',
      createdByKeyId: apiKeyData.id,
    };
  }

  return null;
}

function normaliseProviders(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const providers = [...new Set(input.filter((v): v is string => typeof v === 'string').map((v) => v.trim().toLowerCase()))];
  if (providers.length === 0) return null;
  const invalid = providers.filter((provider) => !VALID_PROVIDERS.includes(provider as (typeof VALID_PROVIDERS)[number]));
  if (invalid.length > 0) return null;
  return providers;
}

function ensureValidRedirectUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).toString();
  } catch {
    return null;
  }
}

function normaliseOrderReference(reference: string): string {
  return reference.trim().toUpperCase();
}

type PublicOrderSummary = {
  id: string;
  buyerName: string | null;
  buyerEmail: string | null;
  buyerPhone: string | null;
  reference: string;
  provider: string;
  amountPaid: number;
  createdAt: string;
  redirectUrl: string | null;
  successMessage: string | null;
  deliveryUrl: string | null;
  productName: string | null;
};

function toPublicOrderSummary(order: {
  id: string;
  buyerName: string | null;
  buyerEmail: string | null;
  buyerPhone: string | null;
  reference: string;
  provider: string;
  amountPaid: number;
  createdAt: Date;
}, paymentLink: {
  name: string;
  redirectUrl: string | null;
  product: { name: string; successMessage: string | null; deliveryUrl: string | null } | null;
}): PublicOrderSummary {
  return {
    id: order.id,
    buyerName: order.buyerName,
    buyerEmail: order.buyerEmail,
    buyerPhone: order.buyerPhone,
    reference: order.reference,
    provider: order.provider,
    amountPaid: order.amountPaid,
    createdAt: order.createdAt.toISOString(),
    redirectUrl: paymentLink.redirectUrl ?? null,
    successMessage: paymentLink.product?.successMessage ?? null,
    deliveryUrl: paymentLink.product?.deliveryUrl ?? null,
    productName: paymentLink.product?.name ?? paymentLink.name,
  };
}

function deriveSellerCbeSuffix(account: string): string | null {
  const digits = account.replace(/\D/g, '');
  if (digits.length < 8) return null;
  return digits.slice(-8);
}

function normaliseBuyerEmail(value: unknown): string | null | 'invalid' {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return 'invalid';

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : 'invalid';
}

function normaliseBuyerName(value: unknown): string | null | 'invalid' {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return 'invalid';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'invalid';
}

function normaliseBuyerPhone(value: unknown): string | null | 'invalid' {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return 'invalid';
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^(09|07)\d{8}$/.test(trimmed) || /^251(9|7)\d{8}$/.test(trimmed) ? trimmed : 'invalid';
}

async function findOrderByReferenceCaseInsensitive(reference: string): Promise<{
  id: string;
  paymentLinkId: string;
} | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string; paymentLinkId: string }>>`
    SELECT id, paymentLinkId
    FROM \`Order\`
    WHERE UPPER(reference) = UPPER(${reference})
    LIMIT 1
  `;

  return rows[0] ?? null;
}

function resolveExpiresAt(expiresInMinutes: unknown): Date | null | 'invalid' {
  if (expiresInMinutes === null || expiresInMinutes === undefined || expiresInMinutes === '') {
    return null;
  }
  if (typeof expiresInMinutes !== 'number' || !Number.isFinite(expiresInMinutes) || expiresInMinutes <= 0) {
    return 'invalid';
  }
  const minutes = Math.min(Math.floor(expiresInMinutes), MAX_EXPIRES_MINUTES);
  return new Date(Date.now() + minutes * 60 * 1000);
}

function materialiseLinkStatus<T extends { id: string; status: string; expiresAt: Date | null }>(
  links: T[],
): T[] {
  const now = new Date();
  const expiredIds = links
    .filter((link) => link.status === 'ACTIVE' && link.expiresAt && link.expiresAt < now)
    .map((link) => link.id);

  if (expiredIds.length > 0) {
    void prisma.paymentLink
      .updateMany({ where: { id: { in: expiredIds } }, data: { status: 'EXPIRED' } })
      .catch((error) => logger.error('Failed to expire payment links:', error));
  }

  return links.map((link) => ({
    ...link,
    status: link.status === 'ACTIVE' && link.expiresAt && link.expiresAt < now ? 'EXPIRED' : link.status,
  }));
}

async function getWorkspacePayoutAccounts(workspaceId: string, ids: string[]) {
  return prisma.payoutAccount.findMany({
    where: {
      workspaceId,
      active: true,
      id: { in: ids },
    },
    select: {
      id: true,
      label: true,
      account: true,
      type: true,
      providersAllowed: true,
      isDefault: true,
    },
  });
}

function ensureProviderCoverage(
  acceptedProviders: string[],
  payoutAccounts: Array<{ providersAllowed: unknown }>,
): string | null {
  for (const provider of acceptedProviders) {
    const matching = payoutAccounts.filter((account) => {
      const allowed = Array.isArray(account.providersAllowed) ? account.providersAllowed as string[] : [];
      return allowed.includes(provider);
    });

    if (matching.length === 0) {
      return `No selected payout account supports ${provider}.`;
    }
    if (matching.length > 1) {
      return `More than one selected payout account supports ${provider}. Use exactly one payout account per accepted provider.`;
    }
  }
  return null;
}

function pickPayoutAccountForProvider<T extends { account: string; providersAllowed: unknown }>(
  provider: string,
  payoutAccounts: T[],
): T | null {
  const matches = payoutAccounts.filter((account) => {
    const allowed = Array.isArray(account.providersAllowed) ? account.providersAllowed as string[] : [];
    return allowed.includes(provider);
  });
  return matches.length === 1 ? matches[0] : null;
}

async function resolveRawApiKey(createdByKeyId: string | null, workspaceId: string, provider: string) {
  if (createdByKeyId) {
    const keyRecord = await prisma.apiKey.findUnique({
      where: { id: createdByKeyId },
      select: { key: true },
    });
    if (keyRecord?.key) return keyRecord.key;
  }

  if (provider === 'cbebirr') {
    const fallbackKey = await prisma.apiKey.findFirst({
      where: {
        workspaceId,
        isActive: true,
        key: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { key: true },
    });
    return fallbackKey?.key ?? undefined;
  }

  return undefined;
}

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const auth = getAuthContext(req);
  if (!auth) {
    res.status(401).json({ success: false, error: 'Authentication required.' });
    return;
  }

  const {
    productId,
    customAmount,
    name,
    acceptedProviders: rawProviders,
    redirectUrl: rawRedirectUrl,
    expiresInMinutes,
    payoutAccountIds,
  } = req.body as {
    productId?: string;
    customAmount?: number;
    name?: string;
    acceptedProviders?: unknown;
    redirectUrl?: string;
    expiresInMinutes?: number | null;
    payoutAccountIds?: string[];
  };

  const hasProduct = typeof productId === 'string' && productId.trim() !== '';
  const hasCustomAmount = typeof customAmount === 'number' && Number.isFinite(customAmount) && customAmount > 0;

  if (hasProduct === hasCustomAmount) {
    res.status(400).json({ success: false, error: 'Provide exactly one of productId or customAmount.' });
    return;
  }

  const acceptedProviders = normaliseProviders(rawProviders);
  if (!acceptedProviders) {
    res.status(400).json({ success: false, error: 'acceptedProviders must be a non-empty array of supported providers.' });
    return;
  }

  const redirectUrl = ensureValidRedirectUrl(rawRedirectUrl);
  if (rawRedirectUrl && !redirectUrl) {
    res.status(400).json({ success: false, error: 'redirectUrl must be a valid URL.' });
    return;
  }

  const expiresAt = resolveExpiresAt(expiresInMinutes);
  if (expiresAt === 'invalid') {
    res.status(400).json({ success: false, error: 'expiresInMinutes must be a positive number when provided.' });
    return;
  }

  const requestedPayoutIds = Array.isArray(payoutAccountIds)
    ? [...new Set(payoutAccountIds.filter((id): id is string => typeof id === 'string' && id.trim() !== ''))]
    : [];

  try {
    if (hasProduct) {
      const product = await prisma.product.findFirst({
        where: { id: productId!.trim(), workspaceId: auth.workspaceId, active: true },
        include: {
          payoutAccounts: {
            where: { active: true },
            select: {
              id: true,
              label: true,
              account: true,
              type: true,
              providersAllowed: true,
              isDefault: true,
            },
          },
        },
      });

      if (!product) {
        res.status(404).json({ success: false, error: 'Product not found.' });
        return;
      }

      const payoutAccounts = requestedPayoutIds.length > 0
        ? product.payoutAccounts.filter((account) => requestedPayoutIds.includes(account.id))
        : product.payoutAccounts;

      if (payoutAccounts.length === 0) {
        res.status(400).json({ success: false, error: 'This product has no active payout accounts available for the payment link.' });
        return;
      }

      const coverageError = ensureProviderCoverage(acceptedProviders, payoutAccounts);
      if (coverageError) {
        res.status(400).json({ success: false, error: coverageError });
        return;
      }

      const created = await prisma.paymentLink.create({
        data: {
          workspaceId: auth.workspaceId,
          productId: product.id,
          createdByKeyId: auth.createdByKeyId,
          creatorType: auth.creatorType,
          name: product.name,
          mode: 'PRODUCT',
          fixedAmount: product.price,
          acceptedProviders,
          redirectUrl,
          expiresAt,
          payoutAccounts: {
            connect: payoutAccounts.map((account) => ({ id: account.id })),
          },
        },
        include: {
          product: { select: { id: true, name: true, price: true } },
          payoutAccounts: { select: { id: true, label: true, account: true, providersAllowed: true, type: true } },
          _count: { select: { orders: true } },
        },
      });

      res.status(201).json({
        success: true,
        paymentLink: created,
        paymentLinkUrl: `${APP_URL}/pl/${created.id}`,
      });
      return;
    }

    if (requestedPayoutIds.length === 0) {
      res.status(400).json({ success: false, error: 'payoutAccountIds is required for custom payment links.' });
      return;
    }

    const payoutAccounts = await getWorkspacePayoutAccounts(auth.workspaceId, requestedPayoutIds);
    if (payoutAccounts.length !== requestedPayoutIds.length) {
      res.status(400).json({ success: false, error: 'One or more payout accounts were not found.' });
      return;
    }

    const coverageError = ensureProviderCoverage(acceptedProviders, payoutAccounts);
    if (coverageError) {
      res.status(400).json({ success: false, error: coverageError });
      return;
    }

    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName) {
      res.status(400).json({ success: false, error: 'name is required for custom payment links.' });
      return;
    }

    const created = await prisma.paymentLink.create({
      data: {
        workspaceId: auth.workspaceId,
        createdByKeyId: auth.createdByKeyId,
        creatorType: auth.creatorType,
        name: trimmedName,
        mode: 'CUSTOM',
        fixedAmount: customAmount!,
        acceptedProviders,
        redirectUrl,
        expiresAt,
        payoutAccounts: {
          connect: payoutAccounts.map((account) => ({ id: account.id })),
        },
      },
      include: {
        payoutAccounts: { select: { id: true, label: true, account: true, providersAllowed: true, type: true } },
        _count: { select: { orders: true } },
      },
    });

    res.status(201).json({
      success: true,
      paymentLink: created,
      paymentLinkUrl: `${APP_URL}/pl/${created.id}`,
    });
  } catch (error) {
    logger.error('Failed to create payment link:', error);
    res.status(500).json({ success: false, error: 'Failed to create payment link.' });
  }
});

router.get('/', async (req: Request, res: Response): Promise<void> => {
  const auth = getAuthContext(req);
  if (!auth) {
    res.status(401).json({ success: false, error: 'Authentication required.' });
    return;
  }

  try {
    const paymentLinks = await prisma.paymentLink.findMany({
      where: { workspaceId: auth.workspaceId },
      orderBy: { createdAt: 'desc' },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            price: true,
            description: true,
            imageUrl: true,
            maxBuyers: true,
            successMessage: true,
            deliveryUrl: true,
          },
        },
        payoutAccounts: {
          select: { id: true, label: true, account: true, type: true, providersAllowed: true },
        },
        _count: { select: { orders: true } },
      },
    });

    res.json({ success: true, paymentLinks: materialiseLinkStatus(paymentLinks) });
  } catch (error) {
    logger.error('Failed to list payment links:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve payment links.' });
  }
});

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const auth = getAuthContext(req);
  if (!auth) {
    res.status(401).json({ success: false, error: 'Authentication required.' });
    return;
  }

  try {
    const paymentLink = await prisma.paymentLink.findFirst({
      where: { id: req.params.id, workspaceId: auth.workspaceId },
      include: {
        product: {
          include: {
            payoutAccounts: {
              select: { id: true, label: true, account: true, type: true, providersAllowed: true },
            },
          },
        },
        payoutAccounts: {
          select: { id: true, label: true, account: true, type: true, providersAllowed: true },
        },
        _count: { select: { orders: true } },
      },
    });

    if (!paymentLink) {
      res.status(404).json({ success: false, error: 'Payment link not found.' });
      return;
    }

    const [withStatus] = materialiseLinkStatus([paymentLink]);
    res.json({ success: true, paymentLink: withStatus });
  } catch (error) {
    logger.error('Failed to get payment link:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve payment link.' });
  }
});

router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
  const auth = getAuthContext(req);
  if (!auth) {
    res.status(401).json({ success: false, error: 'Authentication required.' });
    return;
  }

  const existing = await prisma.paymentLink.findFirst({
    where: { id: req.params.id, workspaceId: auth.workspaceId },
    include: {
      product: {
        include: {
          payoutAccounts: {
            where: { active: true },
            select: { id: true, label: true, account: true, type: true, providersAllowed: true, isDefault: true },
          },
        },
      },
      payoutAccounts: {
        select: { id: true, label: true, account: true, type: true, providersAllowed: true, isDefault: true },
      },
    },
  });

  if (!existing) {
    res.status(404).json({ success: false, error: 'Payment link not found.' });
    return;
  }

  const {
    name,
    customAmount,
    acceptedProviders: rawProviders,
    redirectUrl: rawRedirectUrl,
    expiresInMinutes,
    payoutAccountIds,
    status,
  } = req.body as {
    name?: string;
    customAmount?: number;
    acceptedProviders?: unknown;
    redirectUrl?: string | null;
    expiresInMinutes?: number | null;
    payoutAccountIds?: string[];
    status?: 'ACTIVE' | 'INACTIVE';
  };

  const acceptedProviders = rawProviders === undefined
    ? (Array.isArray(existing.acceptedProviders) ? existing.acceptedProviders as string[] : [])
    : normaliseProviders(rawProviders);
  if (!acceptedProviders) {
    res.status(400).json({ success: false, error: 'acceptedProviders must be a non-empty array of supported providers.' });
    return;
  }

  const redirectUrl = rawRedirectUrl === undefined
    ? existing.redirectUrl
    : rawRedirectUrl === null
      ? null
      : ensureValidRedirectUrl(rawRedirectUrl);
  if (rawRedirectUrl !== undefined && rawRedirectUrl !== null && !redirectUrl) {
    res.status(400).json({ success: false, error: 'redirectUrl must be a valid URL.' });
    return;
  }

  const expiresAt = expiresInMinutes === undefined
    ? existing.expiresAt
    : resolveExpiresAt(expiresInMinutes);
  if (expiresAt === 'invalid') {
    res.status(400).json({ success: false, error: 'expiresInMinutes must be a positive number when provided.' });
    return;
  }

  let resolvedPayoutAccounts = existing.payoutAccounts;
  if (Array.isArray(payoutAccountIds)) {
    const uniqueIds = [...new Set(payoutAccountIds.filter((id): id is string => typeof id === 'string' && id.trim() !== ''))];
    if (uniqueIds.length === 0) {
      res.status(400).json({ success: false, error: 'At least one payout account is required.' });
      return;
    }

    if (existing.productId) {
      const productAccounts = existing.product?.payoutAccounts ?? [];
      resolvedPayoutAccounts = productAccounts.filter((account) => uniqueIds.includes(account.id));
    } else {
      resolvedPayoutAccounts = await getWorkspacePayoutAccounts(auth.workspaceId, uniqueIds);
    }

    if (resolvedPayoutAccounts.length !== uniqueIds.length) {
      res.status(400).json({ success: false, error: 'One or more payout accounts were not found.' });
      return;
    }
  }

  const coverageError = ensureProviderCoverage(acceptedProviders, resolvedPayoutAccounts);
  if (coverageError) {
    res.status(400).json({ success: false, error: coverageError });
    return;
  }

  if (existing.isDefaultForProduct && status === 'INACTIVE') {
    res.status(400).json({ success: false, error: 'The default product payment link cannot be deactivated.' });
    return;
  }

  try {
    const updated = await prisma.paymentLink.update({
      where: { id: existing.id },
      data: {
        ...(existing.mode === 'CUSTOM' && typeof name === 'string' ? { name: name.trim() || existing.name } : {}),
        ...(existing.mode === 'CUSTOM' && typeof customAmount === 'number' && customAmount > 0 ? { fixedAmount: customAmount } : {}),
        acceptedProviders,
        redirectUrl,
        expiresAt: expiresAt as Date | null,
        ...(status ? { status } : {}),
        payoutAccounts: {
          set: resolvedPayoutAccounts.map((account) => ({ id: account.id })),
        },
      },
      include: {
        product: { select: { id: true, name: true, price: true, description: true, imageUrl: true, maxBuyers: true, successMessage: true, deliveryUrl: true } },
        payoutAccounts: { select: { id: true, label: true, account: true, type: true, providersAllowed: true } },
        _count: { select: { orders: true } },
      },
    });

    res.json({ success: true, paymentLink: updated });
  } catch (error) {
    logger.error('Failed to update payment link:', error);
    res.status(500).json({ success: false, error: 'Failed to update payment link.' });
  }
});

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const auth = getAuthContext(req);
  if (!auth) {
    res.status(401).json({ success: false, error: 'Authentication required.' });
    return;
  }

  const existing = await prisma.paymentLink.findFirst({
    where: { id: req.params.id, workspaceId: auth.workspaceId },
    select: { id: true, isDefaultForProduct: true },
  });

  if (!existing) {
    res.status(404).json({ success: false, error: 'Payment link not found.' });
    return;
  }
  if (existing.isDefaultForProduct) {
    res.status(400).json({ success: false, error: 'The default payment link can only be deleted by deleting its product.' });
    return;
  }

  await prisma.paymentLink.delete({ where: { id: existing.id } });
  res.json({ success: true });
});

router.get('/:id/public', async (req: Request, res: Response): Promise<void> => {
  try {
    const paymentLink = await prisma.paymentLink.findUnique({
      where: { id: req.params.id },
      include: {
        product: {
          include: {
            workspace: { select: { name: true } },
          },
        },
        payoutAccounts: {
          select: { id: true, label: true, account: true, type: true, providersAllowed: true },
        },
      },
    });

    if (!paymentLink) {
      res.status(404).json({ success: false, error: 'Payment link not found.' });
      return;
    }

    const [withStatus] = materialiseLinkStatus([paymentLink]);
    res.json({ success: true, paymentLink: withStatus });
  } catch (error) {
    logger.error('Failed to get public payment link:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve payment link.' });
  }
});

router.get('/:id/recent-order', async (req: Request, res: Response): Promise<void> => {
  const orderId = typeof req.query.orderId === 'string' ? req.query.orderId.trim() : '';
  if (!orderId) {
    res.status(400).json({ success: false, error: 'orderId is required.' });
    return;
  }

  try {
    const paymentLink = await prisma.paymentLink.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        workspaceId: true,
        productId: true,
        redirectUrl: true,
        name: true,
        product: {
          select: {
            id: true,
            name: true,
            successMessage: true,
            deliveryUrl: true,
          },
        },
      },
    });

    if (!paymentLink) {
      res.status(404).json({ success: false, error: 'Payment link not found.' });
      return;
    }

    const order = await prisma.order.findFirst({
      where: {
        id: orderId,
        workspaceId: paymentLink.workspaceId,
        status: 'PAID',
        ...(paymentLink.productId
          ? { productId: paymentLink.productId }
          : { paymentLinkId: paymentLink.id }),
      },
      select: {
        id: true,
        buyerName: true,
        buyerEmail: true,
        buyerPhone: true,
        reference: true,
        provider: true,
        amountPaid: true,
        createdAt: true,
      },
    });

    if (!order) {
      res.status(404).json({ success: false, error: 'Order not found.' });
      return;
    }

    res.json({ success: true, recentOrder: toPublicOrderSummary(order, paymentLink) });
  } catch (error) {
    logger.error('Failed to get recent order for payment link:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve the recent order.' });
  }
});

router.post('/:id/confirm', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const {
    reference,
    provider,
    suffix,
    phoneNumber,
    buyerPhone,
    buyerName,
    buyerEmail,
  } = req.body as {
    reference?: string;
    provider?: string;
    suffix?: string;
    phoneNumber?: string;
    buyerPhone?: string;
    buyerName?: string;
    buyerEmail?: string;
  };

  const trimmedReference = typeof reference === 'string' ? reference.trim() : '';
  const normalizedReference = normaliseOrderReference(trimmedReference);
  const trimmedProvider = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  const normalizedBuyerName = normaliseBuyerName(buyerName);
  const normalizedBuyerPhone = normaliseBuyerPhone(buyerPhone ?? phoneNumber);
  const normalizedBuyerEmail = normaliseBuyerEmail(buyerEmail);

  if (!trimmedReference) {
    res.status(400).json({ success: false, error: 'reference is required.' });
    return;
  }
  if (!trimmedProvider) {
    res.status(400).json({ success: false, error: 'provider is required.' });
    return;
  }
  if (normalizedBuyerName === 'invalid' || !normalizedBuyerName) {
    res.status(400).json({ success: false, error: 'buyerName is required.' });
    return;
  }
  if (normalizedBuyerPhone === 'invalid') {
    res.status(400).json({ success: false, error: 'buyerPhone must be a valid Ethiopian phone number.' });
    return;
  }
  if (normalizedBuyerEmail === 'invalid') {
    res.status(400).json({ success: false, error: 'buyerEmail must be a valid email address.' });
    return;
  }
  if (!normalizedBuyerEmail) {
    res.status(400).json({ success: false, error: 'buyerEmail is required.' });
    return;
  }
  if (trimmedProvider === 'cbebirr' && !normalizedBuyerPhone) {
    res.status(400).json({ success: false, error: 'buyerPhone is required for CBE Birr payments.' });
    return;
  }

  const paymentLink = await prisma.paymentLink.findUnique({
    where: { id },
    include: {
      product: {
        include: {
          workspace: {
            select: { name: true },
          },
        },
      },
      payoutAccounts: {
        select: { id: true, label: true, accountHolderName: true, account: true, type: true, providersAllowed: true },
      },
    },
  });

  if (!paymentLink) {
    res.status(404).json({ success: false, error: 'Payment link not found.' });
    return;
  }

  const [withStatus] = materialiseLinkStatus([paymentLink]);
  if (withStatus.status !== 'ACTIVE') {
    res.status(400).json({ success: false, error: 'This payment link is not active.' });
    return;
  }

  const acceptedProviders = Array.isArray(paymentLink.acceptedProviders) ? paymentLink.acceptedProviders as string[] : [];
  if (!acceptedProviders.includes(trimmedProvider)) {
    res.status(400).json({
      success: false,
      error: `This payment link only accepts: ${acceptedProviders.join(', ')}.`,
    });
    return;
  }

  const payoutAccount = pickPayoutAccountForProvider(trimmedProvider, paymentLink.payoutAccounts);
  if (!payoutAccount) {
    res.status(422).json({
      success: false,
      error: `Could not resolve a unique payout account for provider ${trimmedProvider}.`,
    });
    return;
  }

  const existingOrder = await findOrderByReferenceCaseInsensitive(trimmedReference);
  if (existingOrder) {
    const duplicateOrder = await prisma.order.findUnique({
      where: { id: existingOrder.id },
      select: {
        id: true,
        workspaceId: true,
        buyerName: true,
        buyerEmail: true,
        buyerPhone: true,
        reference: true,
        provider: true,
        amountPaid: true,
        createdAt: true,
      },
    });

    const belongsToCurrentBuyer =
      duplicateOrder?.workspaceId === paymentLink.workspaceId &&
      typeof duplicateOrder.buyerEmail === 'string' &&
      duplicateOrder.buyerEmail.trim().toLowerCase() === normalizedBuyerEmail;

    res.status(409).json({
      success: false,
      code: 'REFERENCE_ALREADY_USED',
      error: 'This payment reference has already been used.',
      alreadyOwnedByCurrentBuyer: belongsToCurrentBuyer,
      existingOrder:
        belongsToCurrentBuyer && duplicateOrder
          ? toPublicOrderSummary(duplicateOrder, paymentLink)
          : null,
    });
    return;
  }

  const linkedProduct = paymentLink.product;

  if (linkedProduct && linkedProduct.maxBuyers !== null && paymentLink.productId) {
    const sold = await prisma.order.count({
      where: { productId: paymentLink.productId, status: 'PAID' },
    });
    if (sold >= linkedProduct.maxBuyers) {
      res.status(409).json({ success: false, error: 'Sold out.' });
      return;
    }
  }

  let rawApiKey: string | undefined;
  try {
    rawApiKey = await resolveRawApiKey(paymentLink.createdByKeyId, paymentLink.workspaceId, trimmedProvider);
  } catch {
    rawApiKey = undefined;
  }

  const verificationInput: {
    reference: string;
    suffix?: string;
    phoneNumber?: string;
    apiKey?: string;
  } = {
    reference: trimmedReference,
    apiKey: rawApiKey,
  };

  if (trimmedProvider === 'abyssinia') {
    verificationInput.suffix = suffix?.trim();
  }

  if (trimmedProvider === 'cbe') {
    const legacyCbeLink = extractLegacyCbeUrlData(trimmedReference);

    if (legacyCbeLink) {
      const sellerSuffix = deriveSellerCbeSuffix(payoutAccount.account);
      if (!sellerSuffix) {
        res.status(422).json({
          success: false,
          error: 'The selected payout account does not have a usable CBE account suffix.',
        });
        return;
      }
      verificationInput.suffix = sellerSuffix;
    } else if (!isNewCbeReference(trimmedReference)) {
      verificationInput.suffix = suffix?.trim();
    }
  }

  if (trimmedProvider === 'cbebirr') {
    verificationInput.phoneNumber = normalizedBuyerPhone ?? undefined;
  }

  const verifyResult = await runSmartVerify({
    ...verificationInput,
  });

  if (!verifyResult.success) {
    res.status(verifyResult.httpStatus || 422).json({
      success: false,
      error: verifyResult.error ?? 'Payment verification failed.',
      details: verifyResult.details,
    });
    return;
  }

  const { amount: verifiedAmount, account: verifiedAccount } = extractPaymentDetails(
    verifyResult.data,
    trimmedProvider,
  );

  if (verifiedAmount === null || isNaN(verifiedAmount)) {
    res.status(422).json({
      success: false,
      error: 'Could not extract transaction amount from verification result.',
    });
    return;
  }
  if (verifiedAmount < paymentLink.fixedAmount) {
    res.status(422).json({
      success: false,
      error: `Payment amount mismatch. Expected at least ${paymentLink.fixedAmount} ETB, got ${verifiedAmount} ETB.`,
    });
    return;
  }
  const recipientMatches =
    trimmedProvider === 'cbe'
      ? cbeAccountMatches(verifiedAccount, payoutAccount.account)
      : accountMatches(verifiedAccount, payoutAccount.account);

  if (!recipientMatches) {
    const verifiedRecord = verifyResult.data as Record<string, unknown> | undefined;
    logger.warn('payment-link confirm recipient mismatch', {
      paymentLinkId: paymentLink.id,
      provider: trimmedProvider,
      reference: trimmedReference,
      verifiedAmount,
      expectedAmount: paymentLink.fixedAmount,
      verifiedAccount,
      expectedPayoutAccount: payoutAccount.account,
      expectedMaskedPayoutAccount:
        trimmedProvider === 'cbe' ? maskCbeAccount(payoutAccount.account) : null,
      verifiedReceiver:
        typeof verifiedRecord?.receiver === 'string' ? verifiedRecord.receiver : null,
      expectedAccountHolderName:
        typeof payoutAccount.accountHolderName === 'string' ? payoutAccount.accountHolderName : null,
    });

    res.status(422).json({
      success: false,
      error: 'The payment was not sent to the expected payout account.',
    });
    return;
  }

  try {
    const order = await prisma.order.create({
      data: {
        paymentLinkId: paymentLink.id,
        productId: paymentLink.productId,
        workspaceId: paymentLink.workspaceId,
        buyerName: normalizedBuyerName,
        buyerPhone: normalizedBuyerPhone,
        buyerEmail: normalizedBuyerEmail,
        reference: normalizedReference,
        provider: trimmedProvider,
        amountPaid: verifiedAmount,
        payoutAccount: payoutAccount.account,
        status: 'PAID',
      },
    });

    const linkUrl = `${APP_URL}/pl/${paymentLink.id}`;
    await emitWorkspaceEvent(paymentLink.workspaceId, 'payment_link.paid', {
      order: {
        id: order.id,
        reference: order.reference,
        provider: order.provider,
        amountPaid: order.amountPaid,
        payoutAccount: order.payoutAccount,
        buyerName: order.buyerName,
        buyerPhone: order.buyerPhone,
        buyerEmail: order.buyerEmail,
        createdAt: order.createdAt.toISOString(),
      },
      paymentLink: {
        id: paymentLink.id,
        name: paymentLink.name,
        mode: paymentLink.mode,
        fixedAmount: paymentLink.fixedAmount,
        url: linkUrl,
      },
      ...(linkedProduct && {
        product: {
          id: linkedProduct.id,
          name: linkedProduct.name,
          price: linkedProduct.price,
          url: linkUrl,
        },
      }),
    });

    if (linkedProduct && linkedProduct.maxBuyers !== null && paymentLink.productId) {
      const totalPaid = await prisma.order.count({
        where: { productId: paymentLink.productId, status: 'PAID' },
      });
      if (totalPaid >= linkedProduct.maxBuyers) {
        await emitWorkspaceEvent(paymentLink.workspaceId, 'product.sold_out', {
          product: {
            id: linkedProduct.id,
            name: linkedProduct.name,
            totalOrders: totalPaid,
            maxBuyers: linkedProduct.maxBuyers,
            url: linkUrl,
          },
        });
      }
    }

    if (paymentLink.createdByKeyId) {
      const ip =
        (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
        req.socket.remoteAddress ??
        'unknown';

      void prisma.usageLog.create({
        data: {
          apiKeyId: paymentLink.createdByKeyId,
          endpoint: '/payment-links/confirm',
          method: 'POST',
          statusCode: 200,
          responseTime: 0,
          ip,
        },
      }).catch((error) => logger.error('Failed to write UsageLog for payment link confirm:', error));
    }

    let buyerEmailDelivery: 'sent' | 'failed' = 'sent';
    try {
      await sendBuyerPurchaseEmail({
        to: normalizedBuyerEmail,
        buyerName: normalizedBuyerName,
        sellerName: paymentLink.product?.workspace?.name ?? null,
        productName: paymentLink.product?.name ?? null,
        paymentLinkName: paymentLink.name,
        reference: order.reference,
        provider: order.provider,
        amountPaid: order.amountPaid,
        successMessage: paymentLink.product?.successMessage ?? null,
        deliveryUrl: paymentLink.product?.deliveryUrl ?? null,
        redirectUrl: paymentLink.redirectUrl ?? null,
      });
    } catch (emailError) {
      buyerEmailDelivery = 'failed';
      logger.error('Failed to send buyer purchase email:', emailError);
    }

    res.status(201).json({
      success: true,
      orderId: order.id,
      order: toPublicOrderSummary(order, paymentLink),
      deliveryUrl: paymentLink.product?.deliveryUrl ?? null,
      successMessage: paymentLink.product?.successMessage ?? null,
      redirectUrl: paymentLink.redirectUrl ?? null,
      buyerEmail: normalizedBuyerEmail,
      buyerEmailDelivery,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const duplicateOrder = await prisma.order.findFirst({
        where: {
          reference: normalizedReference,
        },
        select: {
          id: true,
          workspaceId: true,
          buyerName: true,
          buyerEmail: true,
          buyerPhone: true,
          reference: true,
          provider: true,
          amountPaid: true,
          createdAt: true,
        },
      });

      const belongsToCurrentBuyer =
        duplicateOrder?.workspaceId === paymentLink.workspaceId &&
        typeof duplicateOrder.buyerEmail === 'string' &&
        duplicateOrder.buyerEmail.trim().toLowerCase() === normalizedBuyerEmail;

      res.status(409).json({
        success: false,
        code: 'REFERENCE_ALREADY_USED',
        error: 'This payment reference has already been used.',
        alreadyOwnedByCurrentBuyer: belongsToCurrentBuyer,
        existingOrder:
          belongsToCurrentBuyer && duplicateOrder
            ? toPublicOrderSummary(duplicateOrder, paymentLink)
            : null,
      });
      return;
    }

    logger.error('Failed to record order for payment link:', error);
    res.status(500).json({ success: false, error: 'Failed to record order.' });
  }
});

export default router;
