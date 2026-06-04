import { Request, Response, NextFunction } from 'express';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';

const APP_URL = process.env.VERITAS_APP_URL ?? 'https://veritas.et';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the effective plan data for a request from the owning workspace.
 */
function resolveAccount(apiKeyData: any): {
  tier: string;
  grandfathered: boolean;
  imageCredits: number;
  imageCreditsMonthly: number;
  imageCreditsResetAt: Date | null;
  creditHolder: 'workspace';
  creditHolderId: string;
} {
  const ws = apiKeyData?.workspace;
  return {
    tier: ws?.tier ?? 'FREE',
    grandfathered: ws?.grandfathered ?? false,
    imageCredits: ws?.imageCredits ?? 0,
    imageCreditsMonthly: ws?.imageCreditsMonthly ?? 0,
    imageCreditsResetAt: ws?.imageCreditsResetAt ?? null,
    creditHolder: 'workspace',
    creditHolderId: ws?.id ?? apiKeyData?.workspaceId ?? '',
  };
}

/**
 * Parse the key's permissions array from JSON or raw array.
 *
 * Note: ["*"] is NO LONGER honored as a wildcard. It used to bypass tier
 * checks for grandfathered keys, but that accidentally granted 400+ legacy
 * users free access to premium features. The migration `migrate-remove-
 * wildcard` replaces every ["*"] with the tier-appropriate explicit array.
 * If a key somehow still has ["*"], it will fail every premium permission
 * check (which is the safe default).
 */
function parsePermissions(apiKeyData: any): string[] {
  const raw = apiKeyData?.permissions;
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as string[]; } catch { /* fall through */ }
  }
  return ['verify']; // Safe default
}

function hasPermission(apiKeyData: any, permission: string): boolean {
  return parsePermissions(apiKeyData).includes(permission);
}

// ─── Permission gate ──────────────────────────────────────────────────────────
//
// Usage: app.use('/verify-batch', permissionGate('verify-batch'))
//
// Two checks, in order:
//   1. Tier ceiling — premium endpoints (anything other than 'verify') always
//      require PRO or BUSINESS, regardless of what the key's permissions array
//      contains. A FREE user can never use these endpoints, even if their key
//      somehow has the permission listed (e.g. they were on PRO and downgraded).
//   2. Key permission — the permissions array must explicitly contain the
//      required permission. ["*"] is no longer treated as a wildcard.
//
// This is the strict model: grandfathered users keep their basic /verify access
// (since 'verify' is in everyone's permissions), but premium features require
// an active paid plan.

export const permissionGate = (permission: string) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const apiKeyData = (req as any).apiKeyData;
    if (!apiKeyData) { next(); return; }

    // ── 1. Tier ceiling (premium endpoints only) ─────────────────────────────
    if (permission !== 'verify') {
      const { tier } = resolveAccount(apiKeyData);
      if (tier === 'FREE') {
        res.status(402).json({
          success: false,
          error: 'This feature requires a Pro or Business plan.',
          upgrade: `${APP_URL}/dashboard/billing`,
        });
        return;
      }
    }

    // ── 2. Key permission ────────────────────────────────────────────────────
    if (!hasPermission(apiKeyData, permission)) {
      res.status(403).json({
        success: false,
        error: `This API key does not have the '${permission}' permission. ` +
               `Update the key's permissions in the dashboard.`,
        manageKeys: `${APP_URL}/dashboard`,
      });
      return;
    }

    next();
  };

// ─── Backwards-compatible proGate (kept for any existing callers) ─────────────
export const proGate = permissionGate('verify-batch');

// ── /verify-image gate ───────────────────────────────────────────────────────
//
// Execution order:
//   1. Resolve account from workspace
//   2. Tier check: FREE → 402
//   3. Permission check: must have "verify-image"
//   4. Lazy monthly reset (if reset date passed, restore monthly allocation)
//   5. Credit balance check: 0 remaining → 402
//
// The actual decrement (balance -= 1) is done atomically in verifyImage.ts
// AFTER the file is confirmed present, using updateMany + gt:0 guard.

export const verifyImageGate = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const apiKeyData = (req as any).apiKeyData;
  if (!apiKeyData) { next(); return; }

  const account = resolveAccount(apiKeyData);

  // ── 1. Tier ceiling ────────────────────────────────────────────────────────
  // FREE users cannot use image verification, period. No wildcard bypass.
  if (account.tier === 'FREE') {
    res.status(402).json({
      success: false,
      error: 'Image verification requires a Pro or Business plan.',
      upgrade: `${APP_URL}/dashboard/billing`,
    });
    return;
  }

  // ── 2. Key permission ──────────────────────────────────────────────────────
  if (!hasPermission(apiKeyData, 'verify-image')) {
    res.status(403).json({
      success: false,
      error: "This API key does not have the 'verify-image' permission.",
      manageKeys: `${APP_URL}/dashboard`,
    });
    return;
  }

  // ── 3. Lazy monthly reset ──────────────────────────────────────────────────
  const now = new Date();
  if (account.imageCreditsResetAt && now >= account.imageCreditsResetAt) {
    try {
      const nextResetAt = new Date(account.imageCreditsResetAt);
      nextResetAt.setMonth(nextResetAt.getMonth() + 1);

      const resetData = {
        imageCredits: account.imageCreditsMonthly,
        imageCreditsResetAt: nextResetAt,
      };
      const select = { imageCredits: true, imageCreditsResetAt: true } as const;

      const refreshed = await prisma.workspace.update({
        where: { id: account.creditHolderId },
        data: resetData,
        select,
      });

      account.imageCredits = refreshed.imageCredits;
      account.imageCreditsResetAt = refreshed.imageCreditsResetAt;

      logger.info(
        `[tierGate] Monthly reset for ${account.creditHolder} ${account.creditHolderId}: ` +
        `credits restored to ${account.imageCredits}`,
      );
    } catch (err) {
      logger.error(`[tierGate] Monthly reset failed for ${account.creditHolderId}:`, err);
      // Non-fatal: continue with stale value
    }
  }

  // ── 4. Credit balance check ────────────────────────────────────────────────
  if (account.imageCredits <= 0) {
    res.status(402).json({
      success: false,
      error: 'Out of image credits. Top up at veritas.et/dashboard/billing',
      topUp: `${APP_URL}/dashboard/billing`,
    });
    return;
  }

  // Pass resolved account to verifyImage.ts so it knows where to decrement
  (req as any).resolvedAccount = account;
  next();
};
