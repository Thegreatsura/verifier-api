/**
 * fireWebhook.ts
 *
 * Shared utility for firing outbound webhooks.
 *
 * Two flavours:
 *   fireSessionWebhook  – one-off ad-hoc webhook URL.
 *                         Fire-and-forget; not tied to a registered Webhook record.
 *   fireRegisteredWebhook – queues a registered webhook delivery through BullMQ.
 */

import axios from 'axios';
import type { WebhookPayload } from '../queues/webhookQueue';
import { enqueueWebhookDelivery } from '../queues/webhookQueue';
import logger from './logger';

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Fire-and-forget POST to a raw webhook URL.
 * This remains process-local because it is not backed by a registered webhook record.
 */
export function fireSessionWebhook(url: string, payload: Record<string, unknown>): void {
  void axios.post(url, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT_MS,
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown session webhook error';
    logger.warn(`Session webhook delivery failed to ${url}: ${message}`);
  });
}

/**
 * Queue a registered webhook delivery.
 * Legacy signature preserved so existing call sites remain simple during the migration.
 */
export function fireRegisteredWebhook(
  webhookId: string,
  _signingSecret: string | null,
  _url: string,
  payload: Record<string, unknown>,
): void {
  const event = typeof payload.event === 'string' ? payload.event : 'webhook.event';
  void enqueueWebhookDelivery({
    webhookId,
    event,
    payload: payload as WebhookPayload,
  }).catch((error) => {
    logger.error(`Failed to enqueue registered webhook ${webhookId}:`, error);
  });
}
