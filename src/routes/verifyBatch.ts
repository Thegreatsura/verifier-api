import { Router, Request, Response } from 'express';
import { runSmartVerify } from '../services/verifyUniversal';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';
import { getWorkspaceContext } from '../utils/workspaceContext';

const router = Router();

const MAX_BATCH = 20;

interface BatchItem {
  reference: string;
  suffix?: string;
  phoneNumber?: string;
}

interface BatchBody {
  references: BatchItem[];
}

router.post('/', async (req: Request<{}, {}, BatchBody>, res: Response): Promise<void> => {
  const apiKeyData = (req as any).apiKeyData;
  const workspaceContext = getWorkspaceContext(req);

  // ── Tier gate: PRO and BUSINESS only (ALL FREE workspaces blocked) ──────────
  const workspaceTier = workspaceContext?.workspace.tier ?? 'FREE';
  if (!workspaceContext || workspaceTier === 'FREE') {
    res.status(402).json({
      success: false,
      error: 'Batch verification requires a Pro or Business plan.',
      upgrade: 'https://veritas.et/dashboard/billing',
    });
    return;
  }

  const { references } = req.body;

  if (!Array.isArray(references) || references.length === 0) {
    res.status(400).json({ success: false, error: 'references must be a non-empty array.' });
    return;
  }

  if (references.length > MAX_BATCH) {
    res.status(400).json({
      success: false,
      error: `Batch size exceeds maximum of ${MAX_BATCH} references.`,
    });
    return;
  }

  // Pull raw key string for CBE Birr sub-requests
  const rawApiKey = req.headers['x-api-key'] as string | undefined
    ?? req.headers.authorization?.replace('Bearer ', '');

  const startedAt = Date.now();

  // ── Run all verifications concurrently ────────────────────────────────────────
  const settled = await Promise.allSettled(
    references.map((item) =>
      runSmartVerify({
        reference: item.reference,
        suffix: item.suffix,
        phoneNumber: item.phoneNumber,
        apiKey: rawApiKey,
      })
    )
  );

  // ── Build results and log each one to UsageLog ───────────────────────────────
  const results = settled.map((outcome, i) => {
    const item = references[i]!;

    if (outcome.status === 'fulfilled') {
      const r = outcome.value;
      return {
        index: i,
        success: r.success,
        reference: item.reference,
        provider: r.provider,
        ...(r.success ? { data: r.data } : { error: r.error }),
      };
    } else {
      // Promise itself rejected (shouldn't normally happen — runSmartVerify catches internally)
      return {
        index: i,
        success: false,
        reference: item.reference,
        error: outcome.reason instanceof Error ? outcome.reason.message : 'Unexpected error',
      };
    }
  });

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;

  // Log each reference as a separate UsageLog entry (fire-and-forget, non-blocking)
  const responseTime = Date.now() - startedAt;
  const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    ?? req.socket.remoteAddress
    ?? 'unknown';

  void (async () => {
    try {
      if (!apiKeyData?.id) return;
      await prisma.usageLog.createMany({
        data: results.map((r) => ({
          apiKeyId: apiKeyData.id,
          endpoint: '/verify-batch',
          method: 'POST',
          statusCode: r.success ? 200 : 422,
          responseTime,
          ip,
        })),
      });
    } catch (err) {
      logger.error('Failed to write batch UsageLogs:', err);
    }
  })();

  res.json({
    success: true,
    total: results.length,
    succeeded,
    failed,
    results,
  });
});

export default router;
