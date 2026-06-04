/**
 * checkout.ts — Checkout Session endpoints
 *
 * POST   /checkout/sessions               PRO+ — create session
 * GET    /checkout/sessions               PRO+ — list sessions for API key
 * GET    /checkout/sessions/:id           PRO+ — get single session
 * POST   /checkout/sessions/:id/confirm   PUBLIC — end-user payment confirmation
 */

import { Router, Request, Response } from 'express';
import { runSmartVerify } from '../services/verifyUniversal';
import { fireSessionWebhook } from '../utils/fireWebhook';
import { accountMatches, extractPaymentDetails, isValidMerchantAccount } from '../utils/paymentMatch';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';

const router = Router();

const APP_URL = process.env.VERITAS_APP_URL ?? 'https://veritas.et';
const MAX_EXPIRES_MINUTES = 1440; // 24 h
const DEFAULT_EXPIRES_MINUTES = 60;

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Payment matching, provider-specific extraction, and account format validation
// all live in `utils/paymentMatch.ts` and are imported above.

// ─── POST /checkout/sessions ─────────────────────────────────────────────────
// Note: tier/permission gate is applied at the router-mount level in index.ts
// via permissionGate('webhooks') — no redundant check needed here.

router.post('/sessions', async (req: Request, res: Response): Promise<void> => {
  const apiKeyData = (req as any).apiKeyData as { id: string; workspaceId: string };
  const {
    productName,
    expectedAmount,
    merchantAccount,
    acceptedProviders,
    redirectUrl,
    webhookUrl,
    expiresInMinutes,
  } = req.body as {
    productName?: string;
    expectedAmount?: number;
    merchantAccount?: string;
    acceptedProviders?: string[];
    redirectUrl?: string;
    webhookUrl?: string;
    expiresInMinutes?: number;
  };

  // Validation
  if (!productName || typeof productName !== 'string' || productName.trim() === '') {
    res.status(400).json({ success: false, error: 'productName is required.' });
    return;
  }
  if (typeof expectedAmount !== 'number' || expectedAmount <= 0) {
    res.status(400).json({ success: false, error: 'expectedAmount must be a number greater than 0.' });
    return;
  }
  if (!merchantAccount || !isValidMerchantAccount(merchantAccount)) {
    res.status(400).json({
      success: false,
      error:
        'merchantAccount must be a valid Ethiopian phone number (09/251 format) or bank account number (13–16 digits).',
    });
    return;
  }
  if (!Array.isArray(acceptedProviders) || acceptedProviders.length === 0) {
    res.status(400).json({ success: false, error: 'acceptedProviders must be a non-empty array.' });
    return;
  }
  const validProviders = ['telebirr', 'cbe', 'dashen', 'abyssinia', 'cbebirr', 'mpesa'];
  const invalidProviders = acceptedProviders.filter((p) => !validProviders.includes(p));
  if (invalidProviders.length > 0) {
    res.status(400).json({
      success: false,
      error: `Unknown providers: ${invalidProviders.join(', ')}. Valid options: ${validProviders.join(', ')}`,
    });
    return;
  }
  if (!redirectUrl || typeof redirectUrl !== 'string') {
    res.status(400).json({ success: false, error: 'redirectUrl is required.' });
    return;
  }
  try {
    new URL(redirectUrl);
  } catch {
    res.status(400).json({ success: false, error: 'redirectUrl must be a valid URL.' });
    return;
  }
  if (webhookUrl) {
    try {
      new URL(webhookUrl);
    } catch {
      res.status(400).json({ success: false, error: 'webhookUrl must be a valid URL.' });
      return;
    }
  }

  const expMins = typeof expiresInMinutes === 'number'
    ? Math.min(expiresInMinutes, MAX_EXPIRES_MINUTES)
    : DEFAULT_EXPIRES_MINUTES;
  if (expMins <= 0) {
    res.status(400).json({ success: false, error: 'expiresInMinutes must be greater than 0.' });
    return;
  }

  const expiresAt = new Date(Date.now() + expMins * 60 * 1000);

  try {
    const session = await prisma.checkoutSession.create({
      data: {
        workspaceId: apiKeyData.workspaceId,
        createdByKeyId: apiKeyData.id,
        productName: productName.trim(),
        expectedAmount,
        merchantAccount: merchantAccount.trim(),
        acceptedProviders,
        redirectUrl,
        webhookUrl: webhookUrl ?? null,
        expiresAt,
      },
    });

    res.status(201).json({
      sessionId: session.id,
      checkoutUrl: `${APP_URL}/c/${session.id}`,
      expiresAt: session.expiresAt.toISOString(),
    });
  } catch (err) {
    logger.error('Failed to create checkout session:', err);
    res.status(500).json({ success: false, error: 'Failed to create checkout session.' });
  }
});

// ─── GET /checkout/sessions ──────────────────────────────────────────────────

router.get('/sessions', async (req: Request, res: Response): Promise<void> => {
  const apiKeyData = (req as any).apiKeyData as { workspaceId: string };

  try {
    const sessions = await prisma.checkoutSession.findMany({
      where: { workspaceId: apiKeyData.workspaceId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        createdByKeyId: true,
        productName: true,
        expectedAmount: true,
        merchantAccount: true,
        acceptedProviders: true,
        redirectUrl: true,
        status: true,
        paidReference: true,
        createdAt: true,
        expiresAt: true,
      },
    });

    // Lazily mark expired sessions (read-time cleanup, no separate cron needed)
    const now = new Date();
    const toExpire = sessions
      .filter((s) => s.status === 'PENDING' && s.expiresAt < now)
      .map((s) => s.id);

    if (toExpire.length > 0) {
      void prisma.checkoutSession
        .updateMany({ where: { id: { in: toExpire } }, data: { status: 'EXPIRED' } })
        .catch((e) => logger.error('Failed to expire sessions:', e));
    }

    const result = sessions.map((s) => ({
      ...s,
      status: s.status === 'PENDING' && s.expiresAt < now ? 'EXPIRED' : s.status,
    }));

    res.json({ success: true, sessions: result });
  } catch (err) {
    logger.error('Failed to list checkout sessions:', err);
    res.status(500).json({ success: false, error: 'Failed to retrieve checkout sessions.' });
  }
});

// ─── GET /checkout/sessions/:id ──────────────────────────────────────────────

router.get('/sessions/:id', async (req: Request, res: Response): Promise<void> => {
  const apiKeyData = (req as any).apiKeyData as { workspaceId: string };
  const { id } = req.params;

  try {
    const session = await prisma.checkoutSession.findFirst({
      where: { id, workspaceId: apiKeyData.workspaceId },
    });

    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found.' });
      return;
    }

    // Lazy expiry
    if (session.status === 'PENDING' && session.expiresAt < new Date()) {
      await prisma.checkoutSession.update({ where: { id }, data: { status: 'EXPIRED' } });
      res.json({ success: true, session: { ...session, status: 'EXPIRED' } });
      return;
    }

    res.json({ success: true, session });
  } catch (err) {
    logger.error('Failed to get checkout session:', err);
    res.status(500).json({ success: false, error: 'Failed to retrieve session.' });
  }
});

// ─── GET /checkout/sessions/:id/public (PUBLIC) ─────────────────────────────
// No API key required. Returns a safe subset of session data for the hosted
// checkout page. Sensitive fields (redirectUrl internal logic) are omitted.

router.get('/sessions/:id/public', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  try {
    const session = await prisma.checkoutSession.findUnique({
      where: { id },
      select: {
        id: true,
        productName: true,
        expectedAmount: true,
        merchantAccount: true,
        acceptedProviders: true,
        status: true,
        expiresAt: true,
      },
    });

    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found.' });
      return;
    }

    // Lazy expiry at read time
    let status = session.status;
    if (session.status === 'PENDING' && session.expiresAt < new Date()) {
      status = 'EXPIRED';
      void prisma.checkoutSession
        .update({ where: { id }, data: { status: 'EXPIRED' } })
        .catch((e) => logger.error('Failed to lazy-expire session:', e));
    }

    res.json({ success: true, session: { ...session, status } });
  } catch (err) {
    logger.error('Failed to get public checkout session:', err);
    res.status(500).json({ success: false, error: 'Failed to retrieve session.' });
  }
});

// ─── POST /checkout/sessions/:id/confirm (PUBLIC) ────────────────────────────

router.post('/sessions/:id/confirm', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const {
    reference,
    provider,
    suffix,
    phoneNumber,
  } = req.body as {
    reference?: string;
    provider?: string;
    suffix?: string;
    phoneNumber?: string;
  };

  if (!reference || typeof reference !== 'string') {
    res.status(400).json({ success: false, error: 'reference is required.' });
    return;
  }
  if (!provider || typeof provider !== 'string') {
    res.status(400).json({ success: false, error: 'provider is required.' });
    return;
  }

  // ── 1. Load session ─────────────────────────────────────────────────────────
  let session;
  try {
    session = await prisma.checkoutSession.findUnique({ where: { id } });
  } catch (err) {
    logger.error('DB error loading checkout session:', err);
    res.status(500).json({ success: false, error: 'Internal error.' });
    return;
  }

  if (!session) {
    res.status(404).json({ success: false, error: 'Checkout session not found.' });
    return;
  }

  // ── 2. Check status ─────────────────────────────────────────────────────────
  if (session.status === 'PAID') {
    res.status(400).json({ success: false, error: 'This payment has already been confirmed.' });
    return;
  }
  if (session.status === 'EXPIRED') {
    res.status(400).json({ success: false, error: 'This payment link has expired.' });
    return;
  }

  // ── 3. Check expiry (lazy) ──────────────────────────────────────────────────
  if (session.expiresAt < new Date()) {
    await prisma.checkoutSession.update({ where: { id }, data: { status: 'EXPIRED' } });
    res.status(400).json({ success: false, error: 'This payment link has expired.' });
    return;
  }

  // ── 4. Check provider is accepted ──────────────────────────────────────────
  const acceptedProviders = session.acceptedProviders as string[];
  if (!acceptedProviders.includes(provider.toLowerCase())) {
    res.status(400).json({
      success: false,
      error: `Provider "${provider}" is not accepted for this checkout session. Accepted: ${acceptedProviders.join(', ')}.`,
    });
    return;
  }

  // ── 5. Verify the payment ───────────────────────────────────────────────────
  // Get the session owner's API key for the raw key string (needed by CBE Birr)
  let rawApiKey: string | undefined;
  try {
    const keyRecord = await prisma.apiKey.findUnique({
      where: { id: session.createdByKeyId },
      select: { key: true },
    });
    rawApiKey = keyRecord?.key ?? undefined;
  } catch {
    // Non-fatal — CBE Birr will simply fail if key unavailable
  }

  const verifyResult = await runSmartVerify({
    reference: reference.trim(),
    suffix: suffix?.trim(),
    phoneNumber: phoneNumber?.trim(),
    apiKey: rawApiKey,
  });

  if (!verifyResult.success) {
    res.status(422).json({
      success: false,
      error: verifyResult.error ?? 'Payment verification failed.',
      details: verifyResult.details,
    });
    return;
  }

  // ── 6. Validate amount and credited account ─────────────────────────────────
  const { amount: verifiedAmount, account: verifiedAccount } = extractPaymentDetails(
    verifyResult.data,
    provider,
  );

  if (verifiedAmount === null || isNaN(verifiedAmount)) {
    res.status(422).json({
      success: false,
      error: 'Could not extract transaction amount from verification result.',
    });
    return;
  }
  if (verifiedAmount < session.expectedAmount) {
    res.status(422).json({
      success: false,
      error: `Payment amount mismatch. Expected ≥ ${session.expectedAmount} ETB, got ${verifiedAmount} ETB.`,
    });
    return;
  }
  if (!accountMatches(verifiedAccount, session.merchantAccount)) {
    res.status(422).json({
      success: false,
      error: 'The payment was not sent to the expected merchant account.',
    });
    return;
  }

  // ── 7. Mark as PAID ─────────────────────────────────────────────────────────
  try {
    await prisma.checkoutSession.update({
      where: { id },
      data: { status: 'PAID', paidReference: reference.trim() },
    });
  } catch (err) {
    logger.error('Failed to mark session as PAID:', err);
    res.status(500).json({ success: false, error: 'Internal error completing payment.' });
    return;
  }

  // ── 8. Log verification to UsageLog under the session's API key ─────────────
  const ip =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
    req.socket.remoteAddress ??
    'unknown';

  void prisma.usageLog
    .create({
      data: {
        apiKeyId: session.createdByKeyId,
        endpoint: '/checkout/confirm',
        method: 'POST',
        statusCode: 200,
        responseTime: 0,
        ip,
      },
    })
    .catch((e) => logger.error('Failed to write UsageLog for checkout confirm:', e));

  // ── 9. Fire session webhook (fire-and-forget) ───────────────────────────────
  if (session.webhookUrl) {
    fireSessionWebhook(session.webhookUrl, {
      event: 'checkout.paid',
      sessionId: session.id,
      productName: session.productName,
      paidAmount: session.expectedAmount,
      paidReference: reference.trim(),
      provider: provider.toLowerCase(),
      paidAt: new Date().toISOString(),
    });
  }

  res.json({ success: true, redirectUrl: session.redirectUrl });
});

export default router;
