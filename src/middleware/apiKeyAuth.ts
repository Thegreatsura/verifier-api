import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import logger from '../utils/logger';
import { prisma } from '../utils/prisma';
import { AppError, ErrorType, sendErrorResponse } from '../utils/errorHandler';
import {
  BILLING_PAYMENT_OPERATION,
  INTERNAL_OPERATION_HEADER,
  markTrustedInternalOperation,
} from '../utils/trustedInternalOperation';

const ADMIN_SECRET = process.env.ADMIN_SECRET ?? '';
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET ?? '';
const PUBLIC_VERIFY_PATHS = new Set([
  '/verify',
]);

// ─── Key generation ────────────────────────────────────────────────────────────

export const generateApiKey = async (owner: string) => {
  const rawSecret = crypto.randomBytes(24).toString('hex');
  const rawKey = `sk_live_${rawSecret}`;
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const prefix = `sk_live_${rawSecret.substring(0, 6)}...`;

  try {
    const membership = await prisma.membership.findFirst({
      where: { userId: owner },
      orderBy: { createdAt: 'asc' },
      select: { workspaceId: true },
    });
    if (!membership) {
      throw new Error('No workspace found for owner.');
    }

    const apiKey = await prisma.apiKey.create({
      data: {
        keyHash,
        prefix,
        workspaceId: membership.workspaceId,
        usageCount: 0,
        isActive: true,
        permissions: ['verify'],
      },
      include: { workspace: true },
    });
    return { apiKeyRecord: apiKey, rawKey };
  } catch (error) {
    logger.error('Error generating API key:', error);
    throw error;
  }
};

// ─── Key validation ────────────────────────────────────────────────────────────

export const validateApiKey = async (incomingKey: string) => {
  try {
    const incomingHash = crypto.createHash('sha256').update(incomingKey).digest('hex');
    return await prisma.apiKey.findFirst({
      where: {
        isActive: true,
        OR: [
          { keyHash: incomingHash },
          { key: incomingKey }, // Legacy plain-text keys
        ],
      },
      include: {
        workspace: true,
      },
    });
  } catch (error) {
    logger.error('Error validating API key:', error);
    throw error;
  }
};

// ─── Auth middleware ───────────────────────────────────────────────────────────

export const apiKeyAuth = async (req: Request, res: Response, next: NextFunction) => {
  // Public routes that skip API key auth
  if (
    req.path === '/' ||
    req.path === '/health' ||
    req.path === '/ready' ||
    req.path.startsWith('/admin') ||
    /^\/payment-links\/[^/]+\/confirm$/.test(req.path) ||
    /^\/payment-links\/[^/]+\/public$/.test(req.path)
  ) {
    return next();
  }

  // ── Dashboard auth ────────────────────────────────────────────────────────
  // The Next.js UI server authenticates as itself, scoped to a workspace.
  const dashboardKeyHeader = req.headers['x-dashboard-key'] as string | undefined;
  const workspaceIdHeader = req.headers['x-workspace-id'] as string | undefined;
  if (DASHBOARD_SECRET && dashboardKeyHeader === DASHBOARD_SECRET && workspaceIdHeader) {
    try {
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceIdHeader },
      });
      if (!workspace) {
        return res.status(404).json({ success: false, error: 'Workspace not found.' });
      }
      (req as any).workspaceContext = { workspace, source: 'dashboard' };
      (req as any).apiKeyData = null;
      const internalOperation = req.headers[INTERNAL_OPERATION_HEADER] as string | undefined;
      if (
        internalOperation === BILLING_PAYMENT_OPERATION
        && req.method === 'POST'
        && req.path === '/verify'
      ) {
        markTrustedInternalOperation(req, BILLING_PAYMENT_OPERATION);
      }
      return next();
    } catch (error) {
      logger.error('Error looking up workspace for dashboard auth:', error);
      return res.status(500).json({ success: false, error: 'Internal server error.' });
    }
  }

  // ── Public verify proxy auth ───────────────────────────────────────────────
  // The Next.js server can forward public homepage verifications without
  // attributing them to any workspace or API key.
  const publicVerifyHeader = req.headers['x-public-verify-key'] as string | undefined;
  if (DASHBOARD_SECRET && publicVerifyHeader === DASHBOARD_SECRET && PUBLIC_VERIFY_PATHS.has(req.path)) {
    (req as any).publicVerify = true;
    (req as any).apiKeyData = null;
    return next();
  }

  // ── Admin-proxy bypass ─────────────────────────────────────────────────────
  // The Next.js UI sends x-admin-key + x-api-key-id so it can make calls on
  // behalf of a user without their raw key (new-format keys store only a hash).
  const adminKeyHeader = req.headers['x-admin-key'] as string | undefined;
  const keyIdOverride  = req.headers['x-api-key-id'] as string | undefined;
  if (ADMIN_SECRET && adminKeyHeader === ADMIN_SECRET && keyIdOverride) {
    try {
      const keyData = await prisma.apiKey.findUnique({
        where: { id: keyIdOverride, isActive: true },
        include: { workspace: true },
      });
      if (!keyData) {
        return res.status(404).json({ success: false, error: 'API key not found.' });
      }
      (req as any).apiKeyData = keyData;
      return next();
    } catch (error) {
      logger.error('Error looking up API key by ID override:', error);
      return res.status(500).json({ success: false, error: 'Internal server error.' });
    }
  }

  // ── Standard API key auth ──────────────────────────────────────────────────
  const apiKey = req.headers['x-api-key'] || (req.query.apiKey as string);
  if (!apiKey) {
    logger.warn(`API request without API key: ${req.method} ${req.path}`);
    return res.status(401).json({ success: false, error: 'API key is required' });
  }

  try {
    const keyString = Array.isArray(apiKey) ? apiKey[0] : apiKey;
    const keyData = await validateApiKey(keyString);

    if (!keyData) {
      logger.warn('Invalid API key attempt.');
      return res.status(403).json({ success: false, error: 'Invalid API key' });
    }

    // Update usage stats (fire-and-forget, don't block the request)
    prisma.apiKey
      .update({
        where: { id: keyData.id },
        data: { lastUsed: new Date(), usageCount: { increment: 1 } },
      })
      .catch((e) => logger.error('Failed to update key usage stats:', e));

    (req as any).apiKeyData = keyData;
    next();
  } catch (error) {
    logger.error('Error validating API key:', error);
    sendErrorResponse(res, error as AppError);
  }
};

// ─── Admin helper ─────────────────────────────────────────────────────────────

export const getApiKeys = async () => {
  try {
    return await prisma.apiKey.findMany({
      include: { workspace: true },
      orderBy: { createdAt: 'desc' },
    });
  } catch (error) {
    logger.error('Error fetching API keys:', error);
    throw error;
  }
};
