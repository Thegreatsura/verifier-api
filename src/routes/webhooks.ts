/**
 * webhooks.ts — Webhook Management endpoints
 *
 * POST   /webhooks                             PRO+ — register webhook
 * GET    /webhooks                             PRO+ — list with delivery stats
 * DELETE /webhooks/:id                         PRO+ — delete webhook
 * GET    /webhooks/:id/deliveries              PRO+ — list delivery history
 * POST   /webhooks/:id/retry/:deliveryId       PRO+ — manually retry a delivery
 *
 * Ownership model (post-refactor):
 *   Webhooks are owned by the User (account-level), not by a single API key.
 *   The `apiKeyIds` JSON array on each webhook says which keys this webhook
 *   applies to. An empty array means "all of the user's keys."
 *   Any key belonging to the user can list/manage all webhooks the user owns.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { fireRegisteredWebhook } from '../utils/fireWebhook';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';

const router = Router();

const MAX_WEBHOOKS_PER_WORKSPACE = 20;
const DELIVERY_PAGE_SIZE = 50;

const VALID_EVENTS = [
  'checkout.paid',
  'verification.success',
  'verification.failed',
  'order.paid',
  'product.sold_out',
] as const;
type WebhookEvent = (typeof VALID_EVENTS)[number];

// ─── Helper: validate that every keyId in apiKeyIds belongs to workspaceId ───
async function validateKeyIdsBelongToWorkspace(
  keyIds: string[],
  workspaceId: string,
): Promise<{ ok: true } | { ok: false; bad: string[] }> {
  if (keyIds.length === 0) return { ok: true };
  const owned = await prisma.apiKey.findMany({
    where: { id: { in: keyIds }, workspaceId },
    select: { id: true },
  });
  const ownedSet = new Set(owned.map((k) => k.id));
  const bad = keyIds.filter((id) => !ownedSet.has(id));
  return bad.length === 0 ? { ok: true } : { ok: false, bad };
}

// ─── POST /webhooks ───────────────────────────────────────────────────────────
// Body: { url: string, events: string[], apiKeyIds?: string[] }
//   apiKeyIds defaults to [] (applies to all of the user's keys)

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

  const { url, events, apiKeyIds: rawApiKeyIds } = req.body as {
    url?: string;
    events?: string[];
    apiKeyIds?: unknown;
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

  // ── apiKeyIds ──────────────────────────────────────────────────────────────
  const apiKeyIds: string[] = Array.isArray(rawApiKeyIds)
    ? (rawApiKeyIds as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];

  const validation = await validateKeyIdsBelongToWorkspace(apiKeyIds, workspaceId);
  if (!validation.ok) {
    res.status(400).json({
      success: false,
      error: `apiKeyIds contains keys not owned by this account: ${validation.bad.join(', ')}`,
    });
    return;
  }

  // ── Per-workspace cap ──────────────────────────────────────────────────────
  const count = await prisma.webhook.count({ where: { workspaceId, active: true } });
  if (count >= MAX_WEBHOOKS_PER_WORKSPACE) {
    res.status(400).json({
      success: false,
      error: `Maximum of ${MAX_WEBHOOKS_PER_WORKSPACE} active webhooks per workspace.`,
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
        apiKeyIds,
        url,
        events: events as WebhookEvent[],
        signingSecret: rawSecret,
      },
      select: { id: true, url: true, events: true, active: true, apiKeyIds: true, createdAt: true },
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
    const webhooks = await prisma.webhook.findMany({
      where: { workspaceId: apiKeyData.workspaceId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        url: true,
        events: true,
        active: true,
        apiKeyIds: true,
        createdAt: true,
        deliveries: { select: { success: true } },
      },
    });

    const result = webhooks.map(({ deliveries, ...w }) => {
      const total = deliveries.length;
      const succeeded = deliveries.filter((d) => d.success).length;
      return {
        ...w,
        stats: {
          totalDeliveries: total,
          successRate: total > 0 ? Math.round((succeeded / total) * 100) : null,
        },
      };
    });

    res.json({ success: true, webhooks: result });
  } catch (err) {
    logger.error('Failed to list webhooks:', err);
    res.status(500).json({ success: false, error: 'Failed to retrieve webhooks.' });
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
          statusCode: true,
          success: true,
          attempts: true,
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
        select: { id: true, payload: true, success: true },
      });
      if (!delivery) {
        res.status(404).json({ success: false, error: 'Delivery record not found.' });
        return;
      }

      // Fire async — don't wait for the result
      fireRegisteredWebhook(
        webhook.id,
        webhook.signingSecret,
        webhook.url,
        delivery.payload as Record<string, unknown>,
      );

      res.json({
        success: true,
        message: 'Retry enqueued. A new delivery attempt is in progress.',
      });
    } catch (err) {
      logger.error('Failed to retry webhook delivery:', err);
      res.status(500).json({ success: false, error: 'Failed to enqueue retry.' });
    }
  },
);

export default router;
