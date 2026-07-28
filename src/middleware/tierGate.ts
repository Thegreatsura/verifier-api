import { Request, Response, NextFunction } from 'express';
import { prisma } from '../utils/prisma';
import { getWorkspaceContext } from '../utils/workspaceContext';
import {
  addMonths,
  getBatchMaxReferences,
  getMonthlyImageCredits,
  getNotificationChannelLimit,
  getVerificationMonthlyQuota,
  getWebhookLimit,
  type WorkspaceTier,
} from '../config/plans';
import { getBillingConfig, type BillingConfig } from '../config/billingConfig';
import { isTrustedBillingPaymentVerification } from '../utils/trustedInternalOperation';

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
): Promise<BillingConfig> {
  const now = new Date();
  const billingConfig = await getBillingConfig();
  const freeQuota = getVerificationMonthlyQuota('FREE', account.grandfathered, billingConfig);
  const freeImageCredits = getMonthlyImageCredits('FREE', billingConfig);

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
        imageCredits: freeImageCredits,
        imageCreditsMonthly: freeImageCredits,
        imageCreditsResetAt: addMonths(now, 1),
      },
      select: {
        tier: true,
        paidUntil: true,
        planTermMonths: true,
        verificationCredits: true,
        verificationCreditsMonthly: true,
        verificationCreditsResetAt: true,
        imageCreditsMonthly: true,
        imageCredits: true,
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
    account.imageCredits = downgraded.imageCredits;
    account.imageCreditsResetAt = downgraded.imageCreditsResetAt;
  }

  const expectedVerificationQuota = getVerificationMonthlyQuota(account.tier, account.grandfathered, billingConfig);
  if (!account.verificationCreditsResetAt) {
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
        verificationCredits: expectedVerificationQuota,
        verificationCreditsMonthly: expectedVerificationQuota,
        verificationCreditsResetAt: addMonths(now, 1),
      },
      select: {
        verificationCredits: true,
        verificationCreditsMonthly: true,
        verificationCreditsResetAt: true,
      },
    });

    account.verificationCredits = reset.verificationCredits;
    account.verificationCreditsMonthly = reset.verificationCreditsMonthly;
    account.verificationCreditsResetAt = reset.verificationCreditsResetAt;
  }

  const monthlyImageCredits = getMonthlyImageCredits(account.tier, billingConfig);
  if (!account.imageCreditsResetAt) {
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
  } else if (now >= account.imageCreditsResetAt) {
    const refreshed = await prisma.workspace.update({
      where: { id: account.creditHolderId },
      data: {
        imageCredits: monthlyImageCredits,
        imageCreditsMonthly: monthlyImageCredits,
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

  return billingConfig;
}

async function getSyncedPlanState(req: Request): Promise<{
  account: ReturnType<typeof resolveAccount>;
  billingConfig: BillingConfig;
}> {
  const cached = (req as any).resolvedPlanState as {
    account: ReturnType<typeof resolveAccount>;
    billingConfig: BillingConfig;
  } | undefined;
  if (cached) return cached;

  const account = resolveAccount(req);
  const billingConfig = await syncWorkspacePlanState(account);
  const state = { account, billingConfig };
  (req as any).resolvedPlanState = state;
  return state;
}

function getVerificationUnits(req: Request): number | null {
  const routeBase = req.baseUrl;

  if (routeBase === '/verify-batch') {
    const references = req.body?.references;
    if (!Array.isArray(references) || references.length === 0) {
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
//   1. Plan entitlement — Free defaults to no premium resources, but the shared
//      plan configuration can explicitly grant batch/webhook/notification use.
//   2. Key permission — the permissions array must explicitly contain the
//      required permission. ["*"] is no longer treated as a wildcard.
//
// Legacy Free affects only its existing verification quota and 30 rpm rate; it
// does not bypass permissions or acquire resource entitlements implicitly.

export const permissionGate = (permission: string) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = getWorkspaceContext(req);
    if (!context) { next(); return; }

    const { account, billingConfig } = await getSyncedPlanState(req);

    // ── 1. Tier ceiling (premium endpoints only) ─────────────────────────────
    if (permission !== 'verify') {
      if (account.tier === 'FREE') {
        const configuredForFree =
          (permission === 'verify-batch' && getBatchMaxReferences('FREE', billingConfig) > 0)
          || (req.baseUrl === '/webhooks' && getWebhookLimit('FREE', billingConfig) > 0)
          || (req.baseUrl === '/notifications' && getNotificationChannelLimit('FREE', billingConfig) > 0);
        if (!configuredForFree) {
          res.status(402).json({
            success: false,
            error: 'This feature is not included in this plan.',
            upgrade: `${APP_URL}/dashboard/billing`,
          });
          return;
        }
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
//   2. Configured allocation check
//   3. Permission check: must have "verify-image"
//   4. Credit balance check: 0 remaining → 402
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

  const { account } = await getSyncedPlanState(req);

  // ── 1. Tier ceiling ────────────────────────────────────────────────────────
  // A zero configured allocation disables image verification for the plan.
  if (account.imageCreditsMonthly <= 0) {
    res.status(402).json({
      success: false,
      error: 'Image verification is not included in this plan.',
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

  // ── 3. Credit balance check ────────────────────────────────────────────────
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
  if (isTrustedBillingPaymentVerification(req)) {
    next();
    return;
  }

  const context = getWorkspaceContext(req);
  if (!context) { next(); return; }

  const units = getVerificationUnits(req);
  if (!units || units <= 0) {
    next();
    return;
  }

  const { account, billingConfig } = await getSyncedPlanState(req);

  if (req.baseUrl === '/verify-batch') {
    const maxReferences = getBatchMaxReferences(account.tier, billingConfig);
    if (maxReferences <= 0) {
      next();
      return;
    }
    if (maxReferences > 0 && units > maxReferences) {
      res.status(400).json({
        success: false,
        error: `Batch size exceeds maximum of ${maxReferences} references.`,
      });
      return;
    }
  }

  if (account.tier === 'BUSINESS' && billingConfig.businessUnlimitedVerifications) {
    next();
    return;
  }

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
