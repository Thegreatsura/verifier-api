/**
 * fireWebhook.ts
 *
 * Shared utility for firing outbound webhooks.
 *
 * Two flavours:
 *   fireSessionWebhook  – one-off `webhookUrl` on a CheckoutSession.
 *                         Fire-and-forget; not tied to a registered Webhook record.
 *   fireRegisteredWebhook – a registered Webhook (Phase 6). Logs every
 *                           delivery attempt to WebhookDelivery and adds the
 *                           X-Veritas-Signature header.
 */

import axios from 'axios';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import logger from './logger';
import { prisma } from './prisma';

const RETRY_DELAYS_MS = [5_000, 15_000, 45_000]; // backoff after each failed attempt
const REQUEST_TIMEOUT_MS = 10_000;

// ─── Session webhook ──────────────────────────────────────────────────────────

/**
 * Fire-and-forget POST to a checkout session's webhookUrl.
 * Retries up to 3 times with exponential backoff.
 * Not linked to a Webhook DB record — no WebhookDelivery entry is created.
 */
export function fireSessionWebhook(url: string, payload: Record<string, unknown>): void {
  void attempt(url, payload, null, 0);
}

// ─── Registered webhook ───────────────────────────────────────────────────────

/**
 * Fire a registered webhook and log every delivery attempt to WebhookDelivery.
 * Adds X-Veritas-Signature: sha256=HMAC-SHA256(payload, signingSecret).
 *
 * @param webhookId      – the Webhook.id to link the delivery record to
 * @param signingSecret  – the raw signing secret (the same string the customer
 *                         received in the one-time banner on registration).
 *                         Customers verify with HMAC(rawBody, theirSecret).
 * @param url            – target URL
 * @param payload        – JSON body
 */
export function fireRegisteredWebhook(
  webhookId: string,
  signingSecret: string | null,
  url: string,
  payload: Record<string, unknown>,
): void {
  void attempt(url, payload, { webhookId, signingSecret }, 0);
}

// ─── Internal retry loop ─────────────────────────────────────────────────────

interface DeliveryMeta {
  webhookId: string;
  signingSecret: string | null;
}

async function attempt(
  url: string,
  payload: Record<string, unknown>,
  meta: DeliveryMeta | null,
  attemptNumber: number,
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  // Add HMAC signature if we have a signing secret
  if (meta?.signingSecret) {
    const sig = crypto
      .createHmac('sha256', meta.signingSecret)
      .update(JSON.stringify(payload))
      .digest('hex');
    headers['X-Veritas-Signature'] = `sha256=${sig}`;
  }

  try {
    const response = await axios.post(url, payload, {
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    });

    logger.info(
      `✅ Webhook delivered to ${url} [attempt ${attemptNumber + 1}] status=${response.status}`,
    );

    if (meta) {
      await logDelivery(meta.webhookId, payload, response.status, true, attemptNumber + 1);
    }
  } catch (err: unknown) {
    const statusCode =
      axios.isAxiosError(err) ? (err.response?.status ?? null) : null;
    const message =
      err instanceof Error ? err.message : 'Unknown error';

    logger.warn(
      `⚠️  Webhook delivery failed to ${url} [attempt ${attemptNumber + 1}]: ${message}`,
    );

    if (attemptNumber < RETRY_DELAYS_MS.length) {
      // Schedule next retry
      setTimeout(
        () => void attempt(url, payload, meta, attemptNumber + 1),
        RETRY_DELAYS_MS[attemptNumber],
      );
    } else {
      // All retries exhausted
      logger.error(`❌ Webhook permanently failed after ${attemptNumber + 1} attempts to ${url}`);
      if (meta) {
        await logDelivery(meta.webhookId, payload, statusCode, false, attemptNumber + 1);
      }
    }
  }
}

async function logDelivery(
  webhookId: string,
  payload: Record<string, unknown>,
  statusCode: number | null,
  success: boolean,
  attempts: number,
): Promise<void> {
  try {
    await prisma.webhookDelivery.create({
      data: {
        webhookId,
        payload: payload as Prisma.InputJsonValue,
        statusCode,
        success,
        attempts,
      },
    });
  } catch (dbErr) {
    logger.error('Failed to log WebhookDelivery to DB:', dbErr);
  }
}
