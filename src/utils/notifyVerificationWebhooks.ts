/**
 * notifyVerificationWebhooks.ts
 *
 * Emits the calling workspace's verification outcome event so every subscribed
 * delivery surface (registered webhooks, email notifications, Telegram
 * notifications) can fan out from the same event stream.
 *
 * Called once per verification (success or failure) by the response-capturing
 * middleware in `verifyWebhookHook.ts`. Errors here are logged but never
 * propagated — webhook firing must never affect the API response.
 */

import { emitWorkspaceEvent } from './workspaceEvents';
import logger from './logger';

interface NotifyParams {
  workspaceId: string;
  success: boolean;      // true → verification.success, false → verification.failed
  provider?: string;
  reference?: string;
  endpoint: string;      // request path (audit trail)
  data?: unknown;        // response body (passed through to subscribers)
  error?: string;
}

export async function notifyVerificationWebhooks(params: NotifyParams): Promise<void> {
  const { workspaceId, success } = params;
  if (!workspaceId) return;

  try {
    const eventName = success ? 'verification.success' : 'verification.failed';

    await emitWorkspaceEvent(workspaceId, eventName, {
        endpoint: params.endpoint,
        provider: params.provider ?? null,
        reference: params.reference ?? null,
        data: params.data ?? null,
        error: params.error ?? null,
    });
  } catch (err) {
    logger.error('notifyVerificationWebhooks failed:', err);
  }
}
