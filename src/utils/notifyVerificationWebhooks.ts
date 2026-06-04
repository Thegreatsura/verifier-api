/**
 * notifyVerificationWebhooks.ts
 *
 * Loads the calling workspace's registered webhooks, filters them by
 *   (a) event subscription (verification.success / verification.failed)
 *   (b) apiKeyIds applicability (empty = all keys, else must include calling key)
 * and fires each match through the standard fireRegisteredWebhook path.
 *
 * Called once per verification (success or failure) by the response-capturing
 * middleware in `verifyWebhookHook.ts`. Errors here are logged but never
 * propagated — webhook firing must never affect the API response.
 */

import { prisma } from './prisma';
import { fireRegisteredWebhook } from './fireWebhook';
import logger from './logger';

interface NotifyParams {
  apiKeyData: any;       // req.apiKeyData populated by apiKeyAuth
  success: boolean;      // true → verification.success, false → verification.failed
  provider?: string;     // 'telebirr' | 'cbe' | 'dashen' | 'abyssinia' | 'cbebirr' | 'mpesa' | 'image' | undefined
  reference?: string;    // payment reference, when known
  endpoint: string;      // request path (audit trail)
  data?: unknown;        // response body (or its `.data` field), passed through to subscribers
  error?: string;        // when success === false
}

export async function notifyVerificationWebhooks(params: NotifyParams): Promise<void> {
  const { apiKeyData, success } = params;
  if (!apiKeyData?.id) return;

  try {
    const eventName    = success ? 'verification.success' : 'verification.failed';
    const callingKeyId = apiKeyData.id as string;

    const workspaceId: string | null = apiKeyData.workspace?.id ?? apiKeyData.workspaceId ?? null;
    if (!workspaceId) return;

    const webhooks = await prisma.webhook.findMany({
      where: { workspaceId, active: true },
      select: { id: true, url: true, signingSecret: true, events: true, apiKeyIds: true },
    });

    for (const wh of webhooks) {
      const events = Array.isArray(wh.events) ? (wh.events as string[]) : [];
      if (!events.includes(eventName)) continue;

      const keyIds = Array.isArray(wh.apiKeyIds) ? (wh.apiKeyIds as string[]) : [];
      const appliesToThisKey = keyIds.length === 0 || keyIds.includes(callingKeyId);
      if (!appliesToThisKey) continue;

      fireRegisteredWebhook(wh.id, wh.signingSecret, wh.url, {
        event: eventName,
        firedAt: new Date().toISOString(),
        endpoint: params.endpoint,
        provider: params.provider ?? null,
        reference: params.reference ?? null,
        data: params.data ?? null,
        error: params.error ?? null,
      });
    }
  } catch (err) {
    logger.error('notifyVerificationWebhooks failed:', err);
  }
}
