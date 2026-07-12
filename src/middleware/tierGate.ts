import { Request, Response, NextFunction } from 'express';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';
import { getWorkspaceContext } from '../utils/workspaceContext';
import { addMonths, getMonthlyImageCredits, getVerificationMonthlyQuota, type WorkspaceTier } from '../config/plans';
import { getBillingConfig } from '../config/billingConfig';

const APP_URL = process.env.VERITAS_APP_URL ?? 'https://veritas.et';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the effective plan data for a request from workspace context.
 */
function resolveAccount(req: Request): {
  tier: WorkspaceTier;
  grandfathered: boolean;
  verificationCredits: number;
  verificationCreditsMonthly: number;
  verificationCreditsResetAt: Date | null;
  paidUntil: Date | null;
  planTermMonths: number | null;
  imageCredits: number;
  imageCreditsMonthly: number;
  imageCreditsResetAt: Date | null;
  creditHolder: 'workspace';
  creditHolderId: string;
} {
  const context = getWorkspaceContext(req);
  if (context) {
    return {
      tier: context.workspace.tier,
      grandfathered: context.workspace.grandfathered,
      verificationCredits: context.workspace.verificationCredits,
      verificationCreditsMonthly: context.workspace.verificationCreditsMonthly,
      verificationCreditsResetAt: context.workspace.verificationCreditsResetAt,
      paidUntil: context.workspace.paidUntil,
      planTermMonths: context.workspace.planTermMonths,
      imageCredits: context.workspace.imageCredits,
      imageCreditsMonthly: context.workspace.imageCreditsMonthly,
      imageCreditsResetAt: context.workspace.imageCreditsResetAt,
      creditHolder: 'workspace',
      creditHolderId: context.workspace.id,
    };
  }
  
  // Fallback for backward compatibility
  const apiKeyData = (req as any).apiKeyData;
  const ws = apiKeyData?.workspace;
  return {
    tier: ws?.tier ?? 'FREE',
    grandfathered: ws?.grandfathered ?? false,
    verificationCredits: ws?.verificationCredits ?? 0,
    verificationCreditsMonthly: ws?.verificationCreditsMonthly ?? 0,
    verificationCreditsResetAt: ws?.verificationCreditsResetAt ?? null,
    paidUntil: ws?.paidUntil ?? null,
    planTermMonths: ws?.planTermMonths ?? null,
    imageCredits: ws?.imageCredits ?? 0,
    imageCreditsMonthly: ws?.imageCreditsMonthly ?? 0,
    imageCreditsResetAt: ws?.imageCreditsResetAt ?? null,
    creditHolder: 'workspace',
    creditHolderId: ws?.id ?? apiKeyData?.workspaceId ?? '',
  };
}

async function syncWorkspacePlanState(
  account: ReturnType<typeof resolveAccount>,
): Promise<void> {
  const now = new Date();
  const billingConfig = await getBillingConfig();
  const freeQuota = getVerificationMonthlyQuota('FREE', account.grandfathered, billingConfig);

  if (account.tier !== 'FREE' && account.paidUntil && now >= account.paidUntil) {
    const downgraded = await prisma.workspace.update({
      where: { id: account.creditHolderId },
      data: {
        tier: 'FREE',
        paidUntil: null,
        planTermMonths: null,
        verificationCredits: freeQuota,
        verificationCreditsMonthly: freeQuota,
        verificationCreditsResetAt: addMonths(now, 1),
        imageCreditsMonthly: 0,
        imageCreditsResetAt: null,
      },
      select: {
        tier: true,
        paidUntil: true,
        planTermMonths: true,
        verificationCredits: true,
        verificationCreditsMonthly: true,
        verificationCreditsResetAt: true,
        imageCreditsMonthly: true,
        imageCreditsResetAt: true,
      },
    });

    account.tier = downgraded.tier;
    account.paidUntil = downgraded.paidUntil;
    account.planTermMonths = downgraded.planTermMonths;
    account.verificationCredits = downgraded.verificationCredits;
    account.verificationCreditsMonthly = downgraded.verificationCreditsMonthly;
    account.verificationCreditsResetAt = downgraded.verificationCreditsResetAt;
    account.imageCreditsMonthly = downgraded.imageCreditsMonthly;
    account.imageCreditsResetAt = downgraded.imageCreditsResetAt;
  }

  const expectedVerificationQuota = getVerificationMonthlyQuota(account.tier, account.grandfathered, billingConfig);
  if (account.verificationCreditsMonthly <= 0 || !account.verificationCreditsResetAt) {
    const initialized = await prisma.workspace.update({
      where: { id: account.creditHolderId },
      data: {
        verificationCreditsMonthly: expectedVerificationQuota,
        verificationCredits: account.verificationCredits > 0 ? account.verificationCredits : expectedVerificationQuota,
        verificationCreditsResetAt: addMonths(now, 1),
      },
      select: {
        verificationCredits: true,
        verificationCreditsMonthly: true,
        verificationCreditsResetAt: true,
      },
    });

    account.verificationCredits = initialized.verificationCredits;
    account.verificationCreditsMonthly = initialized.verificationCreditsMonthly;
    account.verificationCreditsResetAt = initialized.verificationCreditsResetAt;
  } else if (now >= account.verificationCreditsResetAt) {
    const reset = await prisma.workspace.update({
      where: { id: account.creditHolderId },
      data: {
        verificationCredits: account.verificationCreditsMonthly,
        verificationCreditsResetAt: addMonths(now, 1),
      },
      select: {
        verificationCredits: true,
        verificationCreditsResetAt: true,
      },
    });

    account.verificationCredits = reset.verificationCredits;
    account.verificationCreditsResetAt = reset.verificationCreditsResetAt;
  }

  if (account.tier !== 'FREE' && account.imageCreditsMonthly <= 0) {
    const monthlyImageCredits = getMonthlyImageCredits(account.tier);
    const refreshed = await prisma.workspace.update({
      where: { id: account.creditHolderId },
      data: {
        imageCreditsMonthly: monthlyImageCredits,
        imageCredits: { increment: monthlyImageCredits },
        imageCreditsResetAt: addMonths(now, 1),
      },
      select: {
        imageCredits: true,
        imageCreditsMonthly: true,
        imageCreditsResetAt: true,
      },
    });

    account.imageCredits = refreshed.imageCredits;
    account.imageCreditsMonthly = refreshed.imageCreditsMonthly;
    account.imageCreditsResetAt = refreshed.imageCreditsResetAt;
  }
}

function getVerificationUnits(req: Request): number | null {
  const routeBase = req.baseUrl;

  if (routeBase === '/verify-batch') {
    const references = req.body?.references;
    if (!Array.isArray(references) || references.length === 0 || references.length > 20) {
      return null;
    }
    return references.length;
  }

  if (req.method === 'GET') {
    return typeof req.query.reference === 'string' && req.query.reference.trim().length > 0 ? 1 : null;
  }

  return typeof req.body?.reference === 'string' && req.body.reference.trim().length > 0 ? 1 : null;
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

function hasPermission(req: Request, permission: string): boolean {
  const apiKeyData = (req as any).apiKeyData;
  const context = getWorkspaceContext(req);
  
  // Dashboard auth has no API key, so it has all permissions of the workspace
  if (context?.source === 'dashboard') {
    return true;
  }
  
  // Traditional API key auth checks key permissions
  if (apiKeyData) {
    return parsePermissions(apiKeyData).includes(permission);
  }
  
  return false;
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
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getWorkspaceContext(req);
    if (!context) { next(); return; }

    const account = resolveAccount(req);
    await syncWorkspacePlanState(account);

    // ── 1. Tier ceiling (premium endpoints only) ─────────────────────────────
    if (permission !== 'verify') {
      if (account.tier === 'FREE') {
        res.status(402).json({
          success: false,
          error: 'This feature requires a Pro or Business plan.',
          upgrade: `${APP_URL}/dashboard/billing`,
        });
        return;
      }
    }

    // ── 2. Permission check ──────────────────────────────────────────────────
    // Dashboard auth has all permissions, API key auth checks key permissions
    const apiKeyData = (req as any).apiKeyData;
    if (context.source === 'api_key' && !hasPermission(req, permission)) {
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
  const context = getWorkspaceContext(req);
  if (!context) { next(); return; }

  const account = resolveAccount(req);
  await syncWorkspacePlanState(account);

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

  // ── 2. Permission check ──────────────────────────────────────────────────
  // Dashboard auth has all permissions, API key auth checks key permissions
  const apiKeyData = (req as any).apiKeyData;
  if (context.source === 'api_key' && !hasPermission(req, 'verify-image')) {
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

export const verifyQuotaGate = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const context = getWorkspaceContext(req);
  if (!context) { next(); return; }

  const units = getVerificationUnits(req);
  if (!units || units <= 0) {
    next();
    return;
  }

  const account = resolveAccount(req);
  await syncWorkspacePlanState(account);

  if (account.verificationCredits < units) {
    res.status(402).json({
      success: false,
      error: `Monthly verification quota reached. ${account.verificationCredits} verification${account.verificationCredits === 1 ? '' : 's'} left.`,
      upgrade: `${APP_URL}/dashboard/billing`,
    });
    return;
  }

  const updated = await prisma.workspace.updateMany({
    where: {
      id: account.creditHolderId,
      verificationCredits: { gte: units },
    },
    data: {
      verificationCredits: { decrement: units },
    },
  });

  if (updated.count === 0) {
    res.status(402).json({
      success: false,
      error: 'Monthly verification quota reached.',
      upgrade: `${APP_URL}/dashboard/billing`,
    });
    return;
  }

  next();
};
