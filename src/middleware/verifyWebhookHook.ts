/**
 * verifyWebhookHook.ts
 *
 * Express middleware that wraps `res.json` for verify endpoints. When a verify
 * route responds, this captures the body and fires any matching registered
 * webhooks (verification.success / verification.failed) asynchronously via
 * setImmediate so the API response is never delayed by webhook delivery.
 *
 * Mounted globally before route handlers in `index.ts`. It only activates on
 * paths in SINGLE_VERIFY_PATHS — /verify-batch is skipped because it returns
 * an array of per-item results (would need per-item webhook events; out of
 * scope for v1).
 */

import { Request, Response, NextFunction } from 'express';
import { notifyVerificationWebhooks } from '../utils/notifyVerificationWebhooks';
import { getWorkspaceContext } from '../utils/workspaceContext';
import { isTrustedBillingPaymentVerification } from '../utils/trustedInternalOperation';

// Exact paths that trigger webhook firing. /verify-batch deliberately excluded.
const SINGLE_VERIFY_PATHS = new Set<string>([
  '/verify',
  '/verify-cbe',
  '/verify-telebirr',
  '/verify-dashen',
  '/verify-abyssinia',
  '/verify-cbebirr',
  '/verify-mpesa',
  '/verify-image',
]);

// HTTP status codes that represent an actual verification result (success or
// a real failure from the provider). Excluded: 400 (bad request), 401/403
// (auth), 500 (server error) — these are operational, not verification outcomes.
const VERIFY_OUTCOME_STATUSES = new Set<number>([200, 404, 422, 502]);

/** Pick the first defined string from a list of candidates. */
function pickString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return undefined;
}

/** Derive provider name from the request path: '/verify-telebirr' → 'telebirr'. */
function providerFromPath(path: string): string | undefined {
  // '/verify' (smart router) returns undefined — provider comes from the body.
  const m = /^\/verify-([a-z]+)$/.exec(path);
  return m?.[1];
}

export function verifyWebhookHook(req: Request, res: Response, next: NextFunction): void {
  if (
    !SINGLE_VERIFY_PATHS.has(req.path)
    || isTrustedBillingPaymentVerification(req)
  ) {
    next();
    return;
  }

  const originalJson = res.json.bind(res);
  res.json = function patchedJson(body: unknown): Response {
    // Send the response first; webhook fire is fire-and-forget after that.
    const ret = originalJson(body);

    if (!VERIFY_OUTCOME_STATUSES.has(res.statusCode)) {
      return ret;
    }

    setImmediate(() => {
      const context = getWorkspaceContext(req);
      if (!context?.workspace.id) return;

      const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
      const success = b.success === true || (b.success === undefined && res.statusCode === 200);
      const data = (b.data ?? b) as Record<string, unknown>;

      void notifyVerificationWebhooks({
        workspaceId: context.workspace.id,
        success,
        provider: providerFromPath(req.path) ?? pickString(b.provider, data.provider),
        reference: pickString(req.body?.reference, req.query?.reference, data.reference),
        endpoint: req.path,
        data,
        error: pickString(b.error),
      });
    });

    return ret;
  };

  next();
}
