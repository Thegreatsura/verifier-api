import { Prisma } from '@prisma/client';
import { Request, Response, Router } from 'express';
import { sendBuyerPurchaseEmail } from '../utils/purchaseEmail';
import logger from '../utils/logger';
import { prisma } from '../utils/prisma';

const router = Router();

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

function normalisePositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

router.get('/', async (req: Request, res: Response): Promise<void> => {
  const auth = getAuthContext(req);
  if (!auth) {
    res.status(401).json({ success: false, error: 'Authentication required.' });
    return;
  }

  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const provider = typeof req.query.provider === 'string' ? req.query.provider.trim().toLowerCase() : '';
  const status = typeof req.query.status === 'string' ? req.query.status.trim().toUpperCase() : '';
  const productId = typeof req.query.productId === 'string' ? req.query.productId.trim() : '';
  const page = normalisePositiveInteger(req.query.page, 1, 10_000);
  const pageSize = normalisePositiveInteger(req.query.pageSize, 25, 100);

  const where: Prisma.OrderWhereInput = {
    workspaceId: auth.workspaceId,
  };

  if (provider) {
    where.provider = provider;
  }

  if (status && ['PAID', 'REFUNDED'].includes(status)) {
    where.status = status as 'PAID' | 'REFUNDED';
  }

  if (productId) {
    where.productId = productId;
  }

  if (search) {
    where.OR = [
      { id: { contains: search } },
      { reference: { contains: search } },
      { buyerName: { contains: search } },
      { buyerEmail: { contains: search } },
      { buyerPhone: { contains: search } },
      { product: { name: { contains: search } } },
      { paymentLink: { name: { contains: search } } },
    ];
  }

  try {
    const [total, orders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          buyerName: true,
          buyerEmail: true,
          buyerPhone: true,
          reference: true,
          provider: true,
          amountPaid: true,
          payoutAccount: true,
          status: true,
          createdAt: true,
          paymentLink: {
            select: {
              id: true,
              name: true,
            },
          },
          product: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      }),
    ]);

    res.json({
      success: true,
      orders,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    });
  } catch (error) {
    logger.error('Failed to list orders:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve orders.' });
  }
});

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const auth = getAuthContext(req);
  if (!auth) {
    res.status(401).json({ success: false, error: 'Authentication required.' });
    return;
  }

  try {
    const order = await prisma.order.findFirst({
      where: {
        id: req.params.id,
        workspaceId: auth.workspaceId,
      },
      select: {
        id: true,
        buyerName: true,
        buyerEmail: true,
        buyerPhone: true,
        reference: true,
        provider: true,
        amountPaid: true,
        payoutAccount: true,
        status: true,
        createdAt: true,
        paymentLink: {
          select: {
            id: true,
            name: true,
            redirectUrl: true,
          },
        },
        product: {
          select: {
            id: true,
            name: true,
            successMessage: true,
            deliveryUrl: true,
            workspace: {
              select: {
                name: true,
              },
            },
          },
        },
      },
    });

    if (!order) {
      res.status(404).json({ success: false, error: 'Order not found.' });
      return;
    }

    res.json({ success: true, order });
  } catch (error) {
    logger.error('Failed to retrieve order:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve order.' });
  }
});

router.post('/:id/resend-email', async (req: Request, res: Response): Promise<void> => {
  const auth = getAuthContext(req);
  if (!auth) {
    res.status(401).json({ success: false, error: 'Authentication required.' });
    return;
  }

  try {
    const order = await prisma.order.findFirst({
      where: {
        id: req.params.id,
        workspaceId: auth.workspaceId,
      },
      select: {
        id: true,
        buyerName: true,
        buyerEmail: true,
        reference: true,
        provider: true,
        amountPaid: true,
        paymentLink: {
          select: {
            id: true,
            name: true,
            redirectUrl: true,
          },
        },
        product: {
          select: {
            id: true,
            name: true,
            successMessage: true,
            deliveryUrl: true,
            workspace: {
              select: {
                name: true,
              },
            },
          },
        },
      },
    });

    if (!order) {
      res.status(404).json({ success: false, error: 'Order not found.' });
      return;
    }

    if (!order.buyerEmail) {
      res.status(400).json({ success: false, error: 'This order does not have a buyer email address.' });
      return;
    }

    await sendBuyerPurchaseEmail({
      to: order.buyerEmail,
      buyerName: order.buyerName,
      sellerName: order.product?.workspace?.name ?? null,
      productName: order.product?.name ?? null,
      paymentLinkName: order.paymentLink.name,
      reference: order.reference,
      provider: order.provider,
      amountPaid: order.amountPaid,
      successMessage: order.product?.successMessage ?? null,
      deliveryUrl: order.product?.deliveryUrl ?? null,
      redirectUrl: order.paymentLink.redirectUrl ?? null,
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to resend buyer purchase email:', error);
    res.status(500).json({ success: false, error: 'Failed to resend the buyer purchase email.' });
  }
});

export default router;
