import { Router, Request, Response, RequestHandler, NextFunction } from 'express';
import { generateApiKey, getApiKeys } from '../middleware/apiKeyAuth';
import { getUsageStats } from '../middleware/requestLogger';
import { fireRegisteredWebhook } from '../utils/fireWebhook';
import { getWebhookQueueHealth, replayWebhookDelivery } from '../queues/webhookQueue';
import { verifyTelebirr } from '../services/verifyTelebirr';
import { verifyCBE } from '../services/verifyCBE';
import { verifyCBEBirr } from '../services/verifyCBEBirr';
import { verifyDashen } from '../services/verifyDashen';
import { verifyAbyssinia } from '../services/verifyAbyssinia';
import { verifyMpesa } from '../services/verifyMpesa';
import { accountMatches, extractPaymentDetails } from '../utils/paymentMatch';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';
import {
    BillingConfigValidationError,
    getBillingConfig,
    updateBillingConfig,
} from '../config/billingConfig';

const router = Router();

// Admin secret key for authentication (use environment variable in production)
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-this-secret-key';

// Middleware to check admin authentication
const checkAdminAuth = (req: Request, res: Response, next: NextFunction) => {
    const adminKey = req.headers['x-admin-key'] || req.query.adminKey;

    if (adminKey !== ADMIN_SECRET) {
        return res.status(403).json({ success: false, error: 'Unauthorized admin access' });
    }

    next();
};

router.get('/billing-config', checkAdminAuth as RequestHandler, async (_req: Request, res: Response): Promise<void> => {
    try {
        res.json({ success: true, data: await getBillingConfig() });
    } catch (err) {
        logger.error('Failed to read billing configuration:', err);
        res.status(500).json({ success: false, error: 'Failed to read billing configuration.' });
    }
});

router.patch('/billing-config', checkAdminAuth as RequestHandler, async (req: Request, res: Response): Promise<void> => {
    try {
        const config = await updateBillingConfig(req.body);
        res.json({ success: true, data: config });
    } catch (err) {
        if (err instanceof BillingConfigValidationError) {
            res.status(400).json({ success: false, error: err.message, issues: err.issues });
            return;
        }
        logger.error('Failed to update billing configuration:', err);
        res.status(500).json({ success: false, error: 'Failed to update billing configuration.' });
    }
});

// Generate a new API key
router.post('/api-keys', checkAdminAuth as RequestHandler, async (req: Request, res: Response): Promise<void> => {
    const { owner } = req.body;

    if (!owner) {
        res.status(400).json({ success: false, error: 'Owner name is required' });
        return;
    }

    try {
        const { apiKeyRecord, rawKey } = await generateApiKey(owner);
        logger.info(`New API key generated for ${owner}`);

        res.status(201).json({
            success: true,
            message: "IMPORTANT: Copy this key now. You will not be able to view it again.",
            data: {
                key: rawKey,
                prefix: apiKeyRecord.prefix,
                workspaceId: apiKeyRecord.workspaceId,
                createdAt: apiKeyRecord.createdAt
            }
        });
    } catch (err) {
        logger.error('Error generating API key:', err);
        res.status(500).json({ success: false, error: 'Failed to generate API key' });
    }
});

// Webhook queue health for dashboard/admin visibility
router.get('/webhook-queue-health', checkAdminAuth as RequestHandler, async (_req: Request, res: Response): Promise<void> => {
    try {
        const health = await getWebhookQueueHealth();
        res.json({ success: true, data: health });
    } catch (err) {
        logger.error('Failed to get webhook queue health:', err);
        res.status(500).json({ success: false, error: 'Failed to get webhook queue health.' });
    }
});

// Upgrade/update a single API key's tier or active status
router.patch('/api-keys/:id', checkAdminAuth as RequestHandler, async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const { tier, isActive, grandfathered } = req.body as {
        tier?: string;
        isActive?: boolean;
        grandfathered?: boolean;
    };

    const VALID_TIERS = ['FREE', 'PRO', 'BUSINESS'];
    if (tier !== undefined && !VALID_TIERS.includes(tier)) {
        res.status(400).json({ success: false, error: `Invalid tier. Must be one of: ${VALID_TIERS.join(', ')}` });
        return;
    }

    try {
        const key = await prisma.apiKey.findUnique({
            where: { id },
            select: { id: true, workspaceId: true },
        });
        if (!key) {
            res.status(404).json({ success: false, error: 'API key not found' });
            return;
        }

        if (isActive !== undefined) {
            await prisma.apiKey.update({ where: { id }, data: { isActive } });
        }
        if (tier !== undefined || grandfathered !== undefined) {
            await prisma.workspace.update({
                where: { id: key.workspaceId },
                data: {
                    ...(tier !== undefined && { tier: tier as 'FREE' | 'PRO' | 'BUSINESS' }),
                    ...(grandfathered !== undefined && { grandfathered }),
                },
            });
        }

        const refreshed = await prisma.apiKey.findUnique({
            where: { id },
            select: { id: true, workspaceId: true, isActive: true, workspace: { select: { tier: true, grandfathered: true } } },
        });
        logger.info(`API key ${id} updated: ${JSON.stringify({ tier, isActive, grandfathered })}`);
        res.json({ success: true, data: { id: refreshed!.id, workspaceId: refreshed!.workspaceId, isActive: refreshed!.isActive, tier: refreshed!.workspace?.tier, grandfathered: refreshed!.workspace?.grandfathered } });
    } catch (err: any) {
        if (err.code === 'P2025') {
            res.status(404).json({ success: false, error: 'API key not found' });
            return;
        }
        logger.error('Error updating API key:', err);
        res.status(500).json({ success: false, error: 'Failed to update API key' });
    }
});

// Adjust image credits for a key — used by billing system and manual admin overrides
router.post('/api-keys/:id/credits', checkAdminAuth as RequestHandler, async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const {
        addCredits,
        setMonthly,
        resetAt,
    } = req.body as {
        addCredits?: number;   // positive: grant; negative: deduct
        setMonthly?: number;   // update imageCreditsMonthly baseline
        resetAt?: string;      // ISO date string for next reset (optional)
    };

    if (addCredits === undefined && setMonthly === undefined) {
        res.status(400).json({ success: false, error: 'Provide addCredits and/or setMonthly.' });
        return;
    }

    try {
        const key = await prisma.apiKey.findUnique({ where: { id }, select: { workspaceId: true } });
        if (!key) {
            res.status(404).json({ success: false, error: 'API key not found.' });
            return;
        }

        const updated = await prisma.workspace.update({
            where: { id: key.workspaceId },
            data: {
                ...(addCredits !== undefined && { imageCredits: { increment: addCredits } }),
                ...(setMonthly !== undefined && { imageCreditsMonthly: setMonthly }),
                ...(resetAt !== undefined && { imageCreditsResetAt: new Date(resetAt) }),
            },
            select: { id: true, imageCredits: true, imageCreditsMonthly: true, imageCreditsResetAt: true },
        });

        logger.info(`[admin] Credits updated for workspace ${key.workspaceId} via key ${id}: +${addCredits ?? 0}, monthly=${setMonthly ?? 'unchanged'}`);
        res.json({ success: true, data: updated });
    } catch (err: any) {
        if (err.code === 'P2025') {
            res.status(404).json({ success: false, error: 'API key not found.' });
            return;
        }
        logger.error('Error updating image credits:', err);
        res.status(500).json({ success: false, error: 'Failed to update credits.' });
    }
});

// Update the API keys listing route
router.get('/api-keys', checkAdminAuth as RequestHandler, async (req: Request, res: Response) => {
    try {
        const apiKeys = await getApiKeys();

        // Map over keys safely, supporting both new hashed keys and old legacy keys
        const keyList = apiKeys.map((k) => ({
            id: k.id,
            key: k.prefix || (k.key ? `${k.key.substring(0, 8)}...` : 'Unknown'),
            workspaceId: k.workspaceId,
            tier: k.workspace?.tier || 'FREE',
            createdAt: k.createdAt,
            lastUsed: k.lastUsed,
            usageCount: k.usageCount,
            isActive: k.isActive
        }));

        res.json({ success: true, data: keyList });
    } catch (err) {
        logger.error('Error fetching API keys:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch API keys' });
    }
});

// Update the stats route
router.get('/stats', checkAdminAuth as RequestHandler, async (req: Request, res: Response) => {
    const PRO_PRICE      = Number(process.env.VERITAS_PRO_PRICE      ?? 199);
    const BUSINESS_PRICE = Number(process.env.VERITAS_BUSINESS_PRICE ?? 499);

    try {
        const [
            usageStats,
            paymentLinksByStatus,
            webhookDeliveries,
            tierCounts,
        ] = await Promise.all([
            // Existing request/endpoint stats
            getUsageStats(),

            // Payment links grouped by status
            prisma.paymentLink.groupBy({
                by: ['status'],
                _count: { _all: true },
            }),

            // Webhook delivery success vs. failed
            prisma.webhookDelivery.groupBy({
                by: ['success'],
                _count: { _all: true },
            }),

            // Workspace counts by tier (for revenue estimate)
            prisma.workspace.groupBy({
                by: ['tier'],
                _count: { _all: true },
            }),
        ]);

        // Shape payment link totals
        const paymentLinkStats: Record<string, number> = { ACTIVE: 0, INACTIVE: 0, EXPIRED: 0 };
        for (const row of paymentLinksByStatus) {
            paymentLinkStats[row.status] = row._count._all;
        }
        paymentLinkStats.total =
            paymentLinkStats.ACTIVE + paymentLinkStats.INACTIVE + paymentLinkStats.EXPIRED;

        // Shape delivery totals
        const deliveryStats = { succeeded: 0, failed: 0, total: 0 };
        for (const row of webhookDeliveries) {
            if (row.success) deliveryStats.succeeded = row._count._all;
            else             deliveryStats.failed    = row._count._all;
        }
        deliveryStats.total = deliveryStats.succeeded + deliveryStats.failed;

        // Revenue estimate (active paid keys × monthly price)
        const tierMap: Record<string, number> = { FREE: 0, PRO: 0, BUSINESS: 0 };
        for (const row of tierCounts) {
            tierMap[row.tier] = row._count._all;
        }
        const revenueEstimate = {
            proKeys:            tierMap.PRO,
            businessKeys:       tierMap.BUSINESS,
            monthlyETB:         (tierMap.PRO * PRO_PRICE) + (tierMap.BUSINESS * BUSINESS_PRICE),
            pricePerPro:        PRO_PRICE,
            pricePerBusiness:   BUSINESS_PRICE,
        };

        res.json({
            success: true,
            data: {
                ...usageStats,
                paymentLinks: paymentLinkStats,
                webhookDeliveries: deliveryStats,
                revenue: revenueEstimate,
            },
        });
    } catch (err) {
        logger.error('Error fetching usage stats:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch usage statistics' });
    }
});

// ─── Admin: trigger a webhook retry ───────────────────────────────────────────
// Called by the Veritas UI after it has verified webhook ownership in its own DB.
// No per-user key required — pure server-to-server with x-admin-key.
//
// Body: { webhookId: string, deliveryId: string }
router.post(
  '/webhook-retry',
  checkAdminAuth as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const { webhookId, deliveryId } = req.body as {
      webhookId?: string;
      deliveryId?: string;
    };
    if (!webhookId || !deliveryId) {
      res.status(400).json({ success: false, error: 'webhookId and deliveryId are required.' });
      return;
    }

    try {
      const webhook = await prisma.webhook.findUnique({
        where: { id: webhookId },
        select: { id: true, url: true, signingSecret: true, active: true },
      });
      if (!webhook) {
        res.status(404).json({ success: false, error: 'Webhook not found.' });
        return;
      }
      if (!webhook.active) {
        res.status(400).json({ success: false, error: 'Cannot retry on an inactive webhook.' });
        return;
      }

      const delivery = await prisma.webhookDelivery.findFirst({
        where: { id: deliveryId, webhookId },
        select: { id: true, success: true, status: true },
      });
      if (!delivery) {
        res.status(404).json({ success: false, error: 'Delivery not found.' });
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
        message: delivery.status === 'DEAD_LETTER' ? 'Replay enqueued from dead letter.' : 'Retry enqueued.',
      });
    } catch (err) {
      logger.error('Admin webhook-retry failed:', err);
      res.status(500).json({ success: false, error: 'Failed to enqueue retry.' });
    }
  },
);

// ─── Admin: fire a synthetic test event to a webhook ──────────────────────────
// Called by the Veritas UI from the "Send test" button after it has verified
// webhook ownership. Uses the standard fireRegisteredWebhook path so the
// signature header, retries, and WebhookDelivery logging all behave identically
// to a real production event.
//
// Body: { webhookId: string }
router.post(
  '/webhook-test',
  checkAdminAuth as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const { webhookId } = req.body as { webhookId?: string };
    if (!webhookId) {
      res.status(400).json({ success: false, error: 'webhookId is required.' });
      return;
    }

    try {
      const webhook = await prisma.webhook.findUnique({
        where: { id: webhookId },
        select: { id: true, url: true, signingSecret: true, active: true },
      });
      if (!webhook) {
        res.status(404).json({ success: false, error: 'Webhook not found.' });
        return;
      }
      if (!webhook.active) {
        res.status(400).json({ success: false, error: 'Cannot send a test to an inactive webhook.' });
        return;
      }

      const testPayload = {
        event: 'webhook.test',
        test: true,
        sentAt: new Date().toISOString(),
        webhookId: webhook.id,
        message:
          'This is a test event from your Veritas dashboard. ' +
          'If you can see this on your receiver, your endpoint is reachable. ' +
          'Verify the X-Veritas-Signature header to confirm signing works.',
        sample: {
          reference: 'TEST_REF_ABCDEFGHIJ',
          amount: 100,
          provider: 'telebirr',
        },
      };

      fireRegisteredWebhook(webhook.id, webhook.signingSecret, webhook.url, testPayload);
      res.json({ success: true, message: 'Test event queued for delivery.' });
    } catch (err) {
      logger.error('Admin webhook-test failed:', err);
      res.status(500).json({ success: false, error: 'Failed to send test event.' });
    }
  },
);

// ─── Admin: verify + match a payment (used by the public Product purchase flow) ──
// The UI calls this after a buyer fills the purchase form on /p/[id]. We run the
// provider-specific verification and check the credited account against the
// merchant's payout account. UI is responsible for creating the Order row on
// success — this endpoint only verifies + matches.
//
// Body: {
//   provider:        'telebirr' | 'cbe' | 'cbebirr' | 'dashen' | 'abyssinia' | 'mpesa'
//   reference:       string
//   expectedAccount: string         // merchant's payout account to match
//   expectedAmount:  number         // product price; verifiedAmount must be >=
//   accountSuffix?:  string         // legacy CBE
//   phoneNumber?:    string         // helps CBE Birr verification
// }
//
// Response: { success: true, code: 'MATCH', amount, account } | { success: false, code, error }
router.post(
  '/verify-payment',
  checkAdminAuth as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const {
      provider,
      reference,
      expectedAccount,
      expectedAmount,
      accountSuffix,
      phoneNumber,
      merchantWorkspaceId,
    } = req.body as {
      provider?: string;
      reference?: string;
      expectedAccount?: string;
      expectedAmount?: number;
      accountSuffix?: string;
      phoneNumber?: string;
      /** Owning merchant workspace — needed to resolve a raw API key for CBE Birr. */
      merchantWorkspaceId?: string;
    };

    if (!provider || typeof provider !== 'string') {
      res.status(400).json({ success: false, code: 'BAD_REQUEST', error: 'provider is required.' });
      return;
    }
    if (!reference || typeof reference !== 'string') {
      res.status(400).json({ success: false, code: 'BAD_REQUEST', error: 'reference is required.' });
      return;
    }
    if (!expectedAccount || typeof expectedAccount !== 'string') {
      res.status(400).json({ success: false, code: 'BAD_REQUEST', error: 'expectedAccount is required.' });
      return;
    }
    if (typeof expectedAmount !== 'number' || expectedAmount <= 0) {
      res.status(400).json({ success: false, code: 'BAD_REQUEST', error: 'expectedAmount must be a positive number.' });
      return;
    }

    // ── Direct provider dispatch (NOT smart routing) ─────────────────────────
    // Smart router infers the provider from reference shape — for products the
    // buyer explicitly picked one, so trust that choice and call the service
    // directly. This avoids cases like Telebirr-with-phone routing to CBE Birr.
    const trimmedRef = reference.trim();
    const trimmedPhone = phoneNumber?.trim();
    const trimmedSuffix = accountSuffix?.trim();

    let verifiedData: unknown = null;
    let verifyError: string | null = null;

    try {
      switch (provider.toLowerCase()) {
        case 'telebirr': {
          const result = await verifyTelebirr(trimmedRef);
          if (!result) verifyError = 'Receipt not found or could not be processed.';
          else verifiedData = result;
          break;
        }
        case 'cbe': {
          // verifyCBE supports both new-style tokens (no suffix) and legacy FT* refs
          verifiedData = await verifyCBE(trimmedRef, trimmedSuffix);
          break;
        }
        case 'dashen': {
          verifiedData = await verifyDashen(trimmedRef);
          break;
        }
        case 'abyssinia': {
          if (!trimmedSuffix) {
            verifyError = 'Abyssinia verification requires the 5-digit accountSuffix.';
          } else {
            verifiedData = await verifyAbyssinia(trimmedRef, trimmedSuffix);
          }
          break;
        }
        case 'mpesa': {
          verifiedData = await verifyMpesa(trimmedRef);
          break;
        }
        case 'cbebirr': {
          if (!trimmedPhone) {
            verifyError = 'CBE Birr verification requires a phone number.';
            break;
          }
          verifiedData = await verifyCBEBirr(trimmedRef, trimmedPhone);
          break;
        }
        default:
          res.status(400).json({
            success: false,
            code: 'BAD_REQUEST',
            error: `Unknown provider: ${provider}`,
          });
          return;
      }
    } catch (err) {
      logger.error(`verify-payment: ${provider} verification threw`, err);
      verifyError = err instanceof Error ? err.message : 'Provider verification failed.';
    }

    if (verifyError || !verifiedData) {
      res.status(422).json({
        success: false,
        code: 'NOT_FOUND',
        error: verifyError ?? 'Payment verification failed.',
      });
      return;
    }

    // Extract amount + credited account using the provider-specific shape
    const { amount, account } = extractPaymentDetails(verifiedData, provider);

    if (amount === null || isNaN(amount)) {
      res.status(422).json({
        success: false,
        code: 'AMOUNT_UNKNOWN',
        error: 'Could not determine the verified amount from the provider response.',
      });
      return;
    }
    if (amount < expectedAmount) {
      res.status(422).json({
        success: false,
        code: 'AMOUNT_MISMATCH',
        error: `Payment amount mismatch. Expected ≥ ${expectedAmount} ETB, got ${amount} ETB.`,
        amount,
      });
      return;
    }
    if (!accountMatches(account, expectedAccount)) {
      res.status(422).json({
        success: false,
        code: 'RECIPIENT_MISMATCH',
        error: 'The payment was not sent to the expected merchant account.',
        amount,
        account,
      });
      return;
    }

    res.json({ success: true, code: 'MATCH', amount, account });
  },
);

// ─── Admin: generic webhook notify ────────────────────────────────────────────
// Fires every active webhook in `workspaceId` that's subscribed to `event`
// with the given `payload`. Used by the UI's product purchase flow
// (payment_link.paid, product.sold_out) and any future workspace-level events.
//
// Webhooks always fire workspace-wide — there's no per-key filtering anymore.
//
// Body: { workspaceId, event, payload }
router.post(
  '/notify-user',
  checkAdminAuth as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, event, payload } = req.body as {
      workspaceId?: string;
      event?: string;
      payload?: Record<string, unknown>;
    };

    if (!workspaceId || !event || !payload || typeof payload !== 'object') {
      res.status(400).json({
        success: false,
        error: 'workspaceId, event, and payload object are required.',
      });
      return;
    }

    try {
      const webhooks = await prisma.webhook.findMany({
        where: { workspaceId, active: true },
        select: { id: true, url: true, signingSecret: true, events: true },
      });

      let fired = 0;
      for (const wh of webhooks) {
        const events = Array.isArray(wh.events) ? (wh.events as string[]) : [];
        if (!events.includes(event)) continue;

        fireRegisteredWebhook(wh.id, wh.signingSecret, wh.url, {
          event,
          firedAt: new Date().toISOString(),
          ...payload,
        });
        fired++;
      }

      res.json({ success: true, fired });
    } catch (err) {
      logger.error('notify-user failed:', err);
      res.status(500).json({ success: false, error: 'Failed to fire webhooks.' });
    }
  },
);

export default router;
