/**
 * products router
 *
 * POST   /products             PRO+ — create product
 * GET    /products             PRO+ — list products
 * GET    /products/:id         PRO+ — get single product
 * PATCH  /products/:id         PRO+ — update product
 * DELETE /products/:id         PRO+ — archive product
 * GET    /products/:id/orders  PRO+ — list product orders
 */

import { Prisma } from '@prisma/client';
import { Request, Response, Router } from 'express';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';

const router = Router();

const APP_URL = process.env.VERITAS_APP_URL ?? 'https://veritas.et';
const VALID_PROVIDERS = ['telebirr', 'cbe', 'dashen', 'abyssinia', 'cbebirr', 'mpesa'] as const;

type AuthSource = 'DASHBOARD' | 'API_KEY';

const payoutAccountSelect = Prisma.validator<Prisma.PayoutAccountSelect>()({
  id: true,
  label: true,
  account: true,
  type: true,
  providersAllowed: true,
  isDefault: true,
});

const productListInclude = Prisma.validator<Prisma.ProductInclude>()({
  payoutAccounts: { select: payoutAccountSelect },
  paymentLinks: {
    orderBy: [{ isDefaultForProduct: 'desc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      name: true,
      mode: true,
      fixedAmount: true,
      acceptedProviders: true,
      status: true,
      isDefaultForProduct: true,
      expiresAt: true,
      createdAt: true,
      _count: { select: { orders: true } },
    },
  },
  _count: { select: { orders: true } },
});

const productDetailInclude = Prisma.validator<Prisma.ProductInclude>()({
  payoutAccounts: { select: payoutAccountSelect },
  paymentLinks: {
    orderBy: [{ isDefaultForProduct: 'desc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      name: true,
      mode: true,
      fixedAmount: true,
      acceptedProviders: true,
      status: true,
      isDefaultForProduct: true,
      expiresAt: true,
      createdAt: true,
      redirectUrl: true,
      creatorType: true,
      payoutAccounts: {
        select: payoutAccountSelect,
      },
      _count: { select: { orders: true } },
    },
  },
  _count: { select: { orders: true } },
});

type ProductListRecord = Prisma.ProductGetPayload<{ include: typeof productListInclude }>;
type ProductDetailRecord = Prisma.ProductGetPayload<{ include: typeof productDetailInclude }>;

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
  const providers = [...new Set(input.filter((value): value is string => typeof value === 'string').map((value) => value.trim().toLowerCase()))];
  if (providers.length === 0) return null;
  const invalid = providers.filter((provider) => !VALID_PROVIDERS.includes(provider as (typeof VALID_PROVIDERS)[number]));
  if (invalid.length > 0) return null;
  return providers;
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

function normaliseIdList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter((value): value is string => typeof value === 'string' && value.trim() !== ''))];
}

function normaliseOptionalText(input: unknown): string | null | 'invalid' {
  if (input === undefined) return null;
  if (input === null) return null;
  if (typeof input !== 'string') return 'invalid';
  const trimmed = input.trim();
  return trimmed === '' ? null : trimmed;
}

function normaliseOptionalUrl(input: unknown): string | null | 'invalid' {
  if (input === undefined) return null;
  if (input === null) return null;
  if (typeof input !== 'string') return 'invalid';
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    return new URL(trimmed).toString();
  } catch {
    return 'invalid';
  }
}

function resolvePositiveInteger(input: unknown): number | null | 'invalid' {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) return 'invalid';
  return Math.floor(input);
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
      .catch((error) => logger.error('Failed to expire product payment links:', error));
  }

  return links.map((link) => ({
    ...link,
    status: link.status === 'ACTIVE' && link.expiresAt && link.expiresAt < now ? 'EXPIRED' : link.status,
  }));
}

function serialiseProduct<T extends {
  paymentLinks: Array<{ id: string; status: string; expiresAt: Date | null; isDefaultForProduct: boolean }>;
}>(product: T) {
  const paymentLinks = materialiseLinkStatus(product.paymentLinks).map((link) => ({
    ...link,
    publicUrl: `${APP_URL}/pl/${link.id}`,
  }));
  const defaultPaymentLink = paymentLinks.find((link) => link.isDefaultForProduct) ?? null;

  return {
    ...product,
    paymentLinks,
    defaultPaymentLinkId: defaultPaymentLink?.id ?? null,
    defaultPaymentLinkUrl: defaultPaymentLink ? `${APP_URL}/pl/${defaultPaymentLink.id}` : null,
  };
}

async function getWorkspacePayoutAccounts(workspaceId: string, ids: string[]) {
  return prisma.payoutAccount.findMany({
    where: {
      workspaceId,
      active: true,
      id: { in: ids },
    },
    select: payoutAccountSelect,
  });
}

router.get('/', async (req: Request, res: Response): Promise<void> => {
  const auth = getAuthContext(req);
  if (!auth) {
    res.status(401).json({ success: false, error: 'Authentication required.' });
    return;
  }

  const rawStatus = typeof req.query.status === 'string' ? req.query.status.trim().toLowerCase() : 'active';
  if (!['active', 'inactive', 'all'].includes(rawStatus)) {
    res.status(400).json({ success: false, error: "status must be one of 'active', 'inactive', or 'all'." });
    return;
  }

  const where: Prisma.ProductWhereInput = {
    workspaceId: auth.workspaceId,
    ...(rawStatus === 'active' ? { active: true } : rawStatus === 'inactive' ? { active: false } : {}),
  };

  try {
    const [products, payoutAccounts] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: productListInclude,
      }),
      prisma.payoutAccount.findMany({
        where: { workspaceId: auth.workspaceId, active: true },
        select: payoutAccountSelect,
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      }),
    ]);

    res.json({
      success: true,
      products: products.map((product) => serialiseProduct(product)),
      payoutAccounts,
    });
  } catch (error) {
    logger.error('Failed to list products:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve products.' });
  }
});

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const auth = getAuthContext(req);
  if (!auth) {
    res.status(401).json({ success: false, error: 'Authentication required.' });
    return;
  }

  const body = req.body as {
    name?: unknown;
    description?: unknown;
    imageUrl?: unknown;
    price?: unknown;
    payoutAccountIds?: unknown;
    acceptedProviders?: unknown;
    maxBuyers?: unknown;
    successMessage?: unknown;
    deliveryUrl?: unknown;
  };

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    res.status(400).json({ success: false, error: 'name is required.' });
    return;
  }

  const price = typeof body.price === 'number' ? body.price : NaN;
  if (!Number.isFinite(price) || price <= 0) {
    res.status(400).json({ success: false, error: 'price must be a positive number.' });
    return;
  }

  const acceptedProviders = normaliseProviders(body.acceptedProviders);
  if (!acceptedProviders) {
    res.status(400).json({ success: false, error: 'acceptedProviders must be a non-empty array of supported providers.' });
    return;
  }

  const payoutAccountIds = normaliseIdList(body.payoutAccountIds);
  if (payoutAccountIds.length === 0) {
    res.status(400).json({ success: false, error: 'At least one payout account is required.' });
    return;
  }

  const description = normaliseOptionalText(body.description);
  const imageUrl = normaliseOptionalUrl(body.imageUrl);
  const successMessage = normaliseOptionalText(body.successMessage);
  const deliveryUrl = normaliseOptionalUrl(body.deliveryUrl);
  const maxBuyers = resolvePositiveInteger(body.maxBuyers);

  if (description === 'invalid') {
    res.status(400).json({ success: false, error: 'description must be a string when provided.' });
    return;
  }
  if (imageUrl === 'invalid') {
    res.status(400).json({ success: false, error: 'imageUrl must be a valid URL when provided.' });
    return;
  }
  if (successMessage === 'invalid') {
    res.status(400).json({ success: false, error: 'successMessage must be a string when provided.' });
    return;
  }
  if (deliveryUrl === 'invalid') {
    res.status(400).json({ success: false, error: 'deliveryUrl must be a valid URL when provided.' });
    return;
  }
  if (maxBuyers === 'invalid') {
    res.status(400).json({ success: false, error: 'maxBuyers must be a positive integer when provided.' });
    return;
  }

  try {
    const payoutAccounts = await getWorkspacePayoutAccounts(auth.workspaceId, payoutAccountIds);
    if (payoutAccounts.length !== payoutAccountIds.length) {
      res.status(400).json({ success: false, error: 'One or more payoutAccountIds were not found.' });
      return;
    }

    const coverageError = ensureProviderCoverage(acceptedProviders, payoutAccounts);
    if (coverageError) {
      res.status(400).json({ success: false, error: coverageError });
      return;
    }

    const created = await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          workspaceId: auth.workspaceId,
          name,
          description,
          imageUrl,
          price,
          acceptedProviders,
          maxBuyers,
          successMessage,
          deliveryUrl,
          payoutAccounts: {
            connect: payoutAccounts.map((account) => ({ id: account.id })),
          },
        },
      });

      await tx.paymentLink.create({
        data: {
          workspaceId: auth.workspaceId,
          productId: product.id,
          createdByKeyId: auth.createdByKeyId,
          creatorType: auth.creatorType,
          name: product.name,
          mode: 'PRODUCT',
          fixedAmount: product.price,
          acceptedProviders,
          isDefaultForProduct: true,
          payoutAccounts: {
            connect: payoutAccounts.map((account) => ({ id: account.id })),
          },
        },
      });

      return tx.product.findUnique({
        where: { id: product.id },
        include: productDetailInclude,
      });
    });

    if (!created) {
      res.status(500).json({ success: false, error: 'Failed to load the created product.' });
      return;
    }

    res.status(201).json({
      success: true,
      product: serialiseProduct(created),
    });
  } catch (error) {
    logger.error('Failed to create product:', error);
    res.status(500).json({ success: false, error: 'Failed to create product.' });
  }
});

router.get('/:id/orders', async (req: Request, res: Response): Promise<void> => {
  const auth = getAuthContext(req);
  if (!auth) {
    res.status(401).json({ success: false, error: 'Authentication required.' });
    return;
  }

  try {
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, workspaceId: auth.workspaceId },
      select: { id: true },
    });

    if (!product) {
      res.status(404).json({ success: false, error: 'Product not found.' });
      return;
    }

    const orders = await prisma.order.findMany({
      where: { productId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        reference: true,
        provider: true,
        amountPaid: true,
        buyerName: true,
        buyerPhone: true,
        buyerEmail: true,
        payoutAccount: true,
        status: true,
        createdAt: true,
        paymentLinkId: true,
      },
    });

    res.json({ success: true, orders });
  } catch (error) {
    logger.error('Failed to list product orders:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve product orders.' });
  }
});

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const auth = getAuthContext(req);
  if (!auth) {
    res.status(401).json({ success: false, error: 'Authentication required.' });
    return;
  }

  try {
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, workspaceId: auth.workspaceId },
      include: productDetailInclude,
    });

    if (!product) {
      res.status(404).json({ success: false, error: 'Product not found.' });
      return;
    }

    res.json({ success: true, product: serialiseProduct(product) });
  } catch (error) {
    logger.error('Failed to get product:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve product.' });
  }
});

router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
  const auth = getAuthContext(req);
  if (!auth) {
    res.status(401).json({ success: false, error: 'Authentication required.' });
    return;
  }

  const existing = await prisma.product.findFirst({
    where: { id: req.params.id, workspaceId: auth.workspaceId },
    include: {
      payoutAccounts: {
        where: { active: true },
        select: payoutAccountSelect,
      },
    },
  });

  if (!existing) {
    res.status(404).json({ success: false, error: 'Product not found.' });
    return;
  }

  const body = req.body as {
    name?: unknown;
    description?: unknown;
    imageUrl?: unknown;
    price?: unknown;
    active?: unknown;
    maxBuyers?: unknown;
    successMessage?: unknown;
    deliveryUrl?: unknown;
    acceptedProviders?: unknown;
    payoutAccountIds?: unknown;
  };

  const nextName = body.name === undefined
    ? existing.name
    : typeof body.name === 'string' && body.name.trim()
      ? body.name.trim()
      : null;
  if (nextName === null) {
    res.status(400).json({ success: false, error: 'name must be a non-empty string when provided.' });
    return;
  }

  const nextPrice = body.price === undefined
    ? existing.price
    : typeof body.price === 'number' && Number.isFinite(body.price) && body.price > 0
      ? body.price
      : null;
  if (nextPrice === null) {
    res.status(400).json({ success: false, error: 'price must be a positive number when provided.' });
    return;
  }

  const nextActive = body.active === undefined
    ? existing.active
    : typeof body.active === 'boolean'
      ? body.active
      : null;
  if (nextActive === null) {
    res.status(400).json({ success: false, error: 'active must be a boolean when provided.' });
    return;
  }

  const nextDescription = body.description === undefined ? existing.description : normaliseOptionalText(body.description);
  const nextImageUrl = body.imageUrl === undefined ? existing.imageUrl : normaliseOptionalUrl(body.imageUrl);
  const nextSuccessMessage = body.successMessage === undefined ? existing.successMessage : normaliseOptionalText(body.successMessage);
  const nextDeliveryUrl = body.deliveryUrl === undefined ? existing.deliveryUrl : normaliseOptionalUrl(body.deliveryUrl);
  const nextMaxBuyers = body.maxBuyers === undefined ? existing.maxBuyers : resolvePositiveInteger(body.maxBuyers);

  if (nextDescription === 'invalid') {
    res.status(400).json({ success: false, error: 'description must be a string when provided.' });
    return;
  }
  if (nextImageUrl === 'invalid') {
    res.status(400).json({ success: false, error: 'imageUrl must be a valid URL when provided.' });
    return;
  }
  if (nextSuccessMessage === 'invalid') {
    res.status(400).json({ success: false, error: 'successMessage must be a string when provided.' });
    return;
  }
  if (nextDeliveryUrl === 'invalid') {
    res.status(400).json({ success: false, error: 'deliveryUrl must be a valid URL when provided.' });
    return;
  }
  if (nextMaxBuyers === 'invalid') {
    res.status(400).json({ success: false, error: 'maxBuyers must be a positive integer when provided.' });
    return;
  }

  const acceptedProviders = body.acceptedProviders === undefined
    ? (Array.isArray(existing.acceptedProviders) ? existing.acceptedProviders as string[] : [])
    : normaliseProviders(body.acceptedProviders);
  if (!acceptedProviders || acceptedProviders.length === 0) {
    res.status(400).json({ success: false, error: 'acceptedProviders must be a non-empty array of supported providers.' });
    return;
  }

  const hasPayoutAccountIds = body.payoutAccountIds !== undefined;
  const payoutAccountIds = hasPayoutAccountIds ? normaliseIdList(body.payoutAccountIds) : null;
  if (hasPayoutAccountIds && payoutAccountIds !== null && payoutAccountIds.length === 0) {
    res.status(400).json({ success: false, error: 'At least one payout account is required when payoutAccountIds is provided.' });
    return;
  }

  try {
    const payoutAccounts = payoutAccountIds === null
      ? existing.payoutAccounts
      : await getWorkspacePayoutAccounts(auth.workspaceId, payoutAccountIds);

    if (payoutAccounts.length === 0) {
      res.status(400).json({ success: false, error: 'At least one active payout account is required.' });
      return;
    }
    if (payoutAccountIds !== null && payoutAccounts.length !== payoutAccountIds.length) {
      res.status(400).json({ success: false, error: 'One or more payoutAccountIds were not found.' });
      return;
    }

    const coverageError = ensureProviderCoverage(acceptedProviders, payoutAccounts);
    if (coverageError) {
      res.status(400).json({ success: false, error: coverageError });
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: existing.id },
        data: {
          name: nextName,
          description: nextDescription,
          imageUrl: nextImageUrl,
          price: nextPrice,
          active: nextActive,
          maxBuyers: nextMaxBuyers,
          successMessage: nextSuccessMessage,
          deliveryUrl: nextDeliveryUrl,
          acceptedProviders,
          ...(payoutAccountIds !== null && {
            payoutAccounts: {
              set: payoutAccounts.map((account) => ({ id: account.id })),
            },
          }),
        },
      });

      await tx.paymentLink.updateMany({
        where: { productId: existing.id },
        data: {
          fixedAmount: nextPrice,
          name: nextName,
          acceptedProviders,
          ...(nextActive === false ? { status: 'INACTIVE' } : {}),
        },
      });

      if (payoutAccountIds !== null) {
        const linkIds = await tx.paymentLink.findMany({
          where: { productId: existing.id },
          select: { id: true },
        });

        await Promise.all(linkIds.map((link) => tx.paymentLink.update({
          where: { id: link.id },
          data: {
            payoutAccounts: {
              set: payoutAccounts.map((account) => ({ id: account.id })),
            },
          },
        })));
      }

      return tx.product.findUnique({
        where: { id: existing.id },
        include: productDetailInclude,
      });
    });

    if (!updated) {
      res.status(500).json({ success: false, error: 'Failed to load the updated product.' });
      return;
    }

    res.json({ success: true, product: serialiseProduct(updated) });
  } catch (error) {
    logger.error('Failed to update product:', error);
    res.status(500).json({ success: false, error: 'Failed to update product.' });
  }
});

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const auth = getAuthContext(req);
  if (!auth) {
    res.status(401).json({ success: false, error: 'Authentication required.' });
    return;
  }

  try {
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, workspaceId: auth.workspaceId },
      select: { id: true },
    });

    if (!product) {
      res.status(404).json({ success: false, error: 'Product not found.' });
      return;
    }

    await prisma.$transaction([
      prisma.product.update({
        where: { id: product.id },
        data: { active: false },
      }),
      prisma.paymentLink.updateMany({
        where: { productId: product.id },
        data: { status: 'INACTIVE' },
      }),
    ]);

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to archive product:', error);
    res.status(500).json({ success: false, error: 'Failed to archive product.' });
  }
});

export default router;
