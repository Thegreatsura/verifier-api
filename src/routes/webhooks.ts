/**
 * webhooks.ts — Webhook Management endpoints
 *
 * POST   /webhooks                             PRO+ — register webhook
 * GET    /webhooks                             PRO+ — list with delivery stats
 * DELETE /webhooks/:id                         PRO+ — delete webhook
 * GET    /webhooks/:id/deliveries              PRO+ — list delivery history
 * POST   /webhooks/:id/retry/:deliveryId       PRO+ — manually retry a delivery
 *
 * Webhooks are workspace-owned. Every webhook fires for every matching event
 * in its workspace, regardless of which credential triggered the event.
 * Stripe/Linear/GitHub-style routing — no per-key filtering.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { fireRegisteredWebhook } from '../utils/fireWebhook';
import { replayWebhookDelivery } from '../queues/webhookQueue';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';
import { getBillingConfig } from '../config/billingConfig';
import { getWebhookLimit, type WorkspaceTier } from '../config/plans';

const router = Router();

const DELIVERY_PAGE_SIZE = 50;

const VALID_EVENTS = [
  'payment_link.paid',
  'verification.success',
  'verification.failed',
  'product.sold_out',
  'webhook.dead_letter',
] as const;
type WebhookEvent = (typeof VALID_EVENTS)[number];
type DeliveryStatus = 'QUEUED' | 'PROCESSING' | 'RETRYING' | 'SUCCEEDED' | 'DEAD_LETTER' | 'CANCELLED';

function isValidWebhookEvents(events: unknown): events is WebhookEvent[] {
  return Array.isArray(events)
    && events.length > 0
    && events.every((event) => (VALID_EVENTS as readonly string[]).includes(String(event)));
}

async function getWorkspaceWebhookLimit(req: Request): Promise<number> {
  const tier = ((req as any).apiKeyData?.workspace?.tier ?? 'FREE') as WorkspaceTier;
  return getWebhookLimit(tier, await getBillingConfig());
}

function buildCountMap(
  rows: Array<{ webhookId: string; _count?: { _all?: number } | true }>,
): Map<string, number> {
  return new Map(
    rows.map((row) => [
      row.webhookId,
      typeof row._count === 'object' ? (row._count._all ?? 0) : 0,
    ]),
  );
}

async function listWebhooksWithStats(workspaceId: string) {
  const webhooks = await prisma.webhook.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      url: true,
      events: true,
      active: true,
      createdAt: true,
    },
  });

  if (webhooks.length === 0) {
    return [];
  }

  const webhookIds = webhooks.map((webhook) => webhook.id);
  const [statusCounts, unresolvedDeadLetters, recoveredDeadLetters, lastDeliveries] = await prisma.$transaction([
    prisma.webhookDelivery.groupBy({
      by: ['webhookId', 'status'],
      orderBy: [{ webhookId: 'asc' }, { status: 'asc' }],
      where: { webhookId: { in: webhookIds } },
      _count: { _all: true },
    }),
    prisma.webhookDelivery.groupBy({
      by: ['webhookId'],
      orderBy: { webhookId: 'asc' },
      where: {
        webhookId: { in: webhookIds },
        status: 'DEAD_LETTER',
        resolvedByReplayId: null,
      },
      _count: { _all: true },
    }),
    prisma.webhookDelivery.groupBy({
      by: ['webhookId'],
      orderBy: { webhookId: 'asc' },
      where: {
        webhookId: { in: webhookIds },
        status: 'DEAD_LETTER',
        resolvedByReplayId: { not: null },
      },
      _count: { _all: true },
    }),
    prisma.webhookDelivery.findMany({
      where: { webhookId: { in: webhookIds } },
      orderBy: { createdAt: 'desc' },
      distinct: ['webhookId'],
      select: {
        webhookId: true,
        event: true,
        status: true,
        createdAt: true,
      },
    }),
  ]);

  const statusMap = new Map<string, Partial<Record<DeliveryStatus, number>>>();
  for (const row of statusCounts) {
    const existing = statusMap.get(row.webhookId) ?? {};
    existing[row.status as DeliveryStatus] = typeof row._count === 'object'
      ? (row._count._all ?? 0)
      : 0;
    statusMap.set(row.webhookId, existing);
  }

  const unresolvedDeadMap = buildCountMap(unresolvedDeadLetters);
  const recoveredDeadMap = buildCountMap(recoveredDeadLetters);
  const lastDeliveryMap = new Map(lastDeliveries.map((delivery) => [delivery.webhookId, delivery]));

  return webhooks.map((webhook) => {
    const counts = statusMap.get(webhook.id) ?? {};
    const totalDeliveries = Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0);
    const succeededDeliveries = counts.SUCCEEDED ?? 0;
    const failedDeliveries = (counts.DEAD_LETTER ?? 0) + (counts.CANCELLED ?? 0);
    const inFlightDeliveries = (counts.QUEUED ?? 0) + (counts.PROCESSING ?? 0) + (counts.RETRYING ?? 0);
    const lastDelivery = lastDeliveryMap.get(webhook.id);

    return {
      ...webhook,
      stats: {
        totalDeliveries,
        successRate: totalDeliveries > 0 ? Math.round((succeededDeliveries / totalDeliveries) * 100) : null,
        deadLetters: unresolvedDeadMap.get(webhook.id) ?? 0,
        recoveredDeadLetters: recoveredDeadMap.get(webhook.id) ?? 0,
        inFlightDeliveries,
        succeededDeliveries,
        failedDeliveries,
        lastDeliveryAt: lastDelivery?.createdAt ?? null,
        lastDeliveryStatus: lastDelivery?.status ?? null,
        lastDeliveryEvent: lastDelivery?.event ?? null,
      },
    };
  });
}

// ─── POST /webhooks ───────────────────────────────────────────────────────────
// Body: { url: string, events: string[] }

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const apiKeyData = (req as any).apiKeyData as { workspaceId?: string };
  const workspaceId = apiKeyData.workspaceId;
  if (!workspaceId) {
    res.status(400).json({
      success: false,
      error: 'This API key is not linked to a workspace. Cannot register webhooks.',
    });
    return;
  }

  const { url, events } = req.body as {
    url?: string;
    events?: string[];
  };

  // ── url ────────────────────────────────────────────────────────────────────
  if (!url || typeof url !== 'string') {
    res.status(400).json({ success: false, error: 'url is required.' });
    return;
  }
  try { new URL(url); }
  catch {
    res.status(400).json({ success: false, error: 'url must be a valid URL.' });
    return;
  }

  // ── events ─────────────────────────────────────────────────────────────────
  if (!Array.isArray(events) || events.length === 0) {
    res.status(400).json({ success: false, error: 'events must be a non-empty array.' });
    return;
  }
  const invalidEvents = events.filter((e) => !(VALID_EVENTS as readonly string[]).includes(e));
  if (invalidEvents.length > 0) {
    res.status(400).json({
      success: false,
      error: `Unknown events: ${invalidEvents.join(', ')}. Valid: ${VALID_EVENTS.join(', ')}`,
    });
    return;
  }

  // ── Per-workspace cap ──────────────────────────────────────────────────────
  const webhookLimit = await getWorkspaceWebhookLimit(req);
  const count = await prisma.webhook.count({ where: { workspaceId, active: true } });
  if (count >= webhookLimit) {
    res.status(400).json({
      success: false,
      error: `Maximum of ${webhookLimit} active webhooks per workspace.`,
    });
    return;
  }

  // Generate a signing secret. Stored RAW so we can HMAC the outgoing payload
  // with the same value the customer received — standard verification flow.
  const rawSecret = crypto.randomBytes(32).toString('hex');

  try {
    const webhook = await prisma.webhook.create({
      data: {
        workspaceId,
        url,
        events: events as WebhookEvent[],
        signingSecret: rawSecret,
      },
      select: { id: true, url: true, events: true, active: true, createdAt: true },
    });

    res.status(201).json({
      success: true,
      webhook,
      // Secret shown exactly once — not stored in recoverable form
      secret: rawSecret,
      note: 'Store this secret securely. It will not be shown again. Use it to verify the X-Veritas-Signature header on incoming webhook requests.',
    });
  } catch (err) {
    logger.error('Failed to create webhook:', err);
    res.status(500).json({ success: false, error: 'Failed to register webhook.' });
  }
});

// ─── GET /webhooks ────────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  const apiKeyData = (req as any).apiKeyData as { workspaceId?: string };
  if (!apiKeyData.workspaceId) {
    res.json({ success: true, webhooks: [] });
    return;
  }

  try {
    const webhooks = await listWebhooksWithStats(apiKeyData.workspaceId);
    res.json({ success: true, webhooks });
  } catch (err) {
    logger.error('Failed to list webhooks:', err);
    res.status(500).json({ success: false, error: 'Failed to retrieve webhooks.' });
  }
});

// ─── PATCH /webhooks/:id ──────────────────────────────────────────────────────
// Body: { url?: string, events?: string[], active?: boolean }

router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const workspaceId = (req as any).apiKeyData?.workspaceId as string | undefined;
  if (!workspaceId) {
    res.status(400).json({
      success: false,
      error: 'This API key is not linked to a workspace. Cannot update webhooks.',
    });
    return;
  }

  const { url, events, active } = req.body as {
    url?: string;
    events?: string[];
    active?: boolean;
  };

  if (url === undefined && events === undefined && active === undefined) {
    res.status(400).json({
      success: false,
      error: 'Provide at least one of: url, events, active.',
    });
    return;
  }

  if (url !== undefined) {
    if (typeof url !== 'string') {
      res.status(400).json({ success: false, error: 'url must be a string.' });
      return;
    }
    try {
      new URL(url);
    } catch {
      res.status(400).json({ success: false, error: 'url must be a valid URL.' });
      return;
    }
  }

  if (events !== undefined && !isValidWebhookEvents(events)) {
    const invalidEvents = Array.isArray(events)
      ? events.filter((event) => !(VALID_EVENTS as readonly string[]).includes(event))
      : [];
    res.status(400).json({
      success: false,
      error: invalidEvents.length > 0
        ? `Unknown events: ${invalidEvents.join(', ')}. Valid: ${VALID_EVENTS.join(', ')}`
        : 'events must be a non-empty array.',
    });
    return;
  }

  if (active !== undefined && typeof active !== 'boolean') {
    res.status(400).json({ success: false, error: 'active must be a boolean.' });
    return;
  }

  try {
    const webhook = await prisma.webhook.findFirst({
      where: { id, workspaceId },
      select: { id: true, active: true },
    });
    if (!webhook) {
      res.status(404).json({ success: false, error: 'Webhook not found.' });
      return;
    }

    if (active === true && !webhook.active) {
      const webhookLimit = await getWorkspaceWebhookLimit(req);
      const activeCount = await prisma.webhook.count({ where: { workspaceId, active: true } });
      if (activeCount >= webhookLimit) {
        res.status(400).json({
          success: false,
          error: `Maximum of ${webhookLimit} active webhooks per workspace.`,
        });
        return;
      }
    }

    const updatedWebhook = await prisma.webhook.update({
      where: { id },
      data: {
        ...(url !== undefined ? { url } : {}),
        ...(events !== undefined ? { events: events as WebhookEvent[] } : {}),
        ...(active !== undefined ? { active } : {}),
      },
      select: {
        id: true,
        url: true,
        events: true,
        active: true,
        createdAt: true,
      },
    });

    res.json({ success: true, webhook: updatedWebhook });
  } catch (err) {
    logger.error('Failed to update webhook:', err);
    res.status(500).json({ success: false, error: 'Failed to update webhook.' });
  }
});

// ─── POST /webhooks/:id/rotate-secret ─────────────────────────────────────────

router.post('/:id/rotate-secret', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const workspaceId = (req as any).apiKeyData?.workspaceId as string | undefined;
  if (!workspaceId) {
    res.status(400).json({
      success: false,
      error: 'This API key is not linked to a workspace. Cannot rotate webhook secrets.',
    });
    return;
  }

  try {
    const webhook = await prisma.webhook.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!webhook) {
      res.status(404).json({ success: false, error: 'Webhook not found.' });
      return;
    }

    const rawSecret = crypto.randomBytes(32).toString('hex');
    const updatedWebhook = await prisma.webhook.update({
      where: { id },
      data: { signingSecret: rawSecret },
      select: {
        id: true,
        url: true,
        events: true,
        active: true,
        createdAt: true,
      },
    });

    res.json({
      success: true,
      webhook: updatedWebhook,
      secret: rawSecret,
      note: 'Store this new secret securely. Previous signatures will stop validating with the old secret.',
    });
  } catch (err) {
    logger.error('Failed to rotate webhook secret:', err);
    res.status(500).json({ success: false, error: 'Failed to rotate webhook secret.' });
  }
});

// ─── DELETE /webhooks/:id ─────────────────────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  try {
    const webhook = await prisma.webhook.findFirst({
      where: { id, workspaceId: (req as any).apiKeyData.workspaceId },
    });
    if (!webhook) {
      res.status(404).json({ success: false, error: 'Webhook not found.' });
      return;
    }
    await prisma.webhook.delete({ where: { id } });
    res.json({ success: true, message: 'Webhook deleted.' });
  } catch (err) {
    logger.error('Failed to delete webhook:', err);
    res.status(500).json({ success: false, error: 'Failed to delete webhook.' });
  }
});

// ─── GET /webhooks/:id/deliveries ─────────────────────────────────────────────

router.get('/:id/deliveries', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? String(DELIVERY_PAGE_SIZE)), 10)));

  try {
    const webhook = await prisma.webhook.findFirst({
      where: { id, workspaceId: (req as any).apiKeyData.workspaceId },
      select: { id: true },
    });
    if (!webhook) {
      res.status(404).json({ success: false, error: 'Webhook not found.' });
      return;
    }

    const [deliveries, total] = await prisma.$transaction([
      prisma.webhookDelivery.findMany({
        where: { webhookId: id },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          event: true,
          statusCode: true,
          success: true,
          status: true,
          attempts: true,
          maxAttempts: true,
          lastError: true,
          nextRetryAt: true,
          deliveredAt: true,
          replayOfDeliveryId: true,
          resolvedByReplayId: true,
          resolvedAt: true,
          createdAt: true,
        },
      }),
      prisma.webhookDelivery.count({ where: { webhookId: id } }),
    ]);

    res.json({
      success: true,
      deliveries,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    logger.error('Failed to list webhook deliveries:', err);
    res.status(500).json({ success: false, error: 'Failed to retrieve deliveries.' });
  }
});

// ─── POST /webhooks/:id/retry/:deliveryId ─────────────────────────────────────

router.post(
  '/:id/retry/:deliveryId',
  async (req: Request, res: Response): Promise<void> => {
    const { id, deliveryId } = req.params;

    try {
      const webhook = await prisma.webhook.findFirst({
        where: { id, workspaceId: (req as any).apiKeyData.workspaceId },
        select: { id: true, url: true, signingSecret: true, active: true },
      });
      if (!webhook) {
        res.status(404).json({ success: false, error: 'Webhook not found.' });
        return;
      }
      if (!webhook.active) {
        res.status(400).json({ success: false, error: 'Cannot retry a delivery for an inactive webhook.' });
        return;
      }

      const delivery = await prisma.webhookDelivery.findFirst({
        where: { id: deliveryId, webhookId: id },
        select: { id: true, success: true, status: true },
      });
      if (!delivery) {
        res.status(404).json({ success: false, error: 'Delivery record not found.' });
        return;
      }
      if (delivery.success) {
        res.status(400).json({ success: false, error: 'Successful deliveries cannot be replayed.' });
        return;
      }

      const replay = await replayWebhookDelivery(webhook.id, delivery.id);

      res.json({
        success: true,
        replayDeliveryId: replay.deliveryId,
        message: delivery.status === 'DEAD_LETTER'
          ? 'Replay enqueued from dead letter.'
          : 'Retry enqueued. A new delivery attempt is in progress.',
      });
    } catch (err) {
      logger.error('Failed to retry webhook delivery:', err);
      res.status(500).json({ success: false, error: 'Failed to enqueue retry.' });
    }
  },
);

export default router;
