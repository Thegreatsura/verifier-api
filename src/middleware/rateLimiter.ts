import { Request, Response, NextFunction } from 'express';
import { getWorkspaceContext } from '../utils/workspaceContext';
import { getRateLimit } from '../config/plans';
import { getBillingConfig } from '../config/billingConfig';
import { getRequestIp } from '../utils/requestIp';
import { isTrustedBillingPaymentVerification } from '../utils/trustedInternalOperation';

const WINDOW_MS = 60 * 1000;
const PUBLIC_VERIFY_WINDOW_MS = 60 * 60 * 1000;
const PUBLIC_VERIFY_LIMIT = 6;

const store = new Map<string, { count: number; windowStart: number }>();

export const rateLimiter = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (isTrustedBillingPaymentVerification(req)) {
    next();
    return;
  }

  const context = getWorkspaceContext(req);
  const requestIp = getRequestIp(req);

  if (!context) {
    if (!(req as any).publicVerify) {
      next();
      return;
    }

    const rateLimitKey = `public:${requestIp}`;
    const now = Date.now();
    const entry = store.get(rateLimitKey);

    if (!entry || now - entry.windowStart >= PUBLIC_VERIFY_WINDOW_MS) {
      store.set(rateLimitKey, { count: 1, windowStart: now });
      next();
      return;
    }

    entry.count++;
    if (entry.count > PUBLIC_VERIFY_LIMIT) {
      const retryAfter = Math.ceil((entry.windowStart + PUBLIC_VERIFY_WINDOW_MS - now) / 1000);
      res.status(429).json({
        success: false,
        error: 'Public verification limit reached. Create a workspace to keep verifying more references.',
        retryAfter,
      });
      return;
    }

    next();
    return;
  }

  const nowDate = new Date();
  const tier = context.workspace.paidUntil && nowDate >= context.workspace.paidUntil
    ? 'FREE'
    : context.workspace.tier;
  const grandfathered = context.workspace.grandfathered;

  const billingConfig = await getBillingConfig();
  const limit = getRateLimit(tier, grandfathered, billingConfig);

  // Determine rate limit key based on auth source
  let rateLimitKey: string;
  if (context.source === 'dashboard') {
    // For dashboard auth, use workspace ID + IP address
    rateLimitKey = `dashboard:${context.workspace.id}:${requestIp}`;
  } else {
    // For API key auth, use API key ID
    const apiKeyData = (req as any).apiKeyData;
    rateLimitKey = apiKeyData?.id || 'unknown';
  }

  const now    = Date.now();
  const entry  = store.get(rateLimitKey);

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    store.set(rateLimitKey, { count: 1, windowStart: now });
    next();
    return;
  }

  entry.count++;
  if (entry.count > limit) {
    const retryAfter = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);
    res.status(429).json({
      success: false,
      error: 'Rate limit exceeded.',
      retryAfter,
    });
    return;
  }

  next();
};
