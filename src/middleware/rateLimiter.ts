import { Request, Response, NextFunction } from 'express';

const WINDOW_MS = 60 * 1000;

// Requests per minute by tier
const LIMITS: Record<string, number> = {
  FREE:               10,
  FREE_GRANDFATHERED: 30,
  PRO:                60,
  BUSINESS:           300,
};

const store = new Map<string, { count: number; windowStart: number }>();

export const rateLimiter = (req: Request, res: Response, next: NextFunction): void => {
  const apiKeyData = (req as any).apiKeyData;
  if (!apiKeyData) { next(); return; }

  const ws = apiKeyData.workspace;
  const tier = ws?.tier ?? 'FREE';
  const grandfathered = ws?.grandfathered ?? false;

  const limitKey = tier === 'FREE' && grandfathered ? 'FREE_GRANDFATHERED' : tier;
  const limit    = LIMITS[limitKey] ?? 10;

  const { id } = apiKeyData;
  const now    = Date.now();
  const entry  = store.get(id);

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    store.set(id, { count: 1, windowStart: now });
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
