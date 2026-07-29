import type { ConnectionOptions, Job } from 'bullmq';
import { Queue, Worker } from 'bullmq';
import { Prisma } from '@prisma/client';

import logger from '../utils/logger';
import { prisma } from '../utils/prisma';

const QUEUE_NAME = 'workspace-notifications';
const RETRY_DELAYS_MS = [10_000, 30_000, 90_000] as const;
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const COMPLETED_JOB_RETENTION = 500;
const FAILED_JOB_RETENTION = 500;
const RECONCILIATION_INTERVAL_MS = 60_000;
const STALE_DELIVERY_AGE_MS = 60_000;
const ACTIVE_JOB_STATES = new Set([
  'active',
  'delayed',
  'prioritized',
  'waiting',
  'waiting-children',
]);

type NotificationChannelType = 'EMAIL' | 'TELEGRAM';
export type NotificationEventName =
  | 'payment_link.paid'
  | 'product.sold_out'
  | 'verification.success'
  | 'verification.failed'
  | 'webhook.dead_letter'
  | 'notification.test';

export interface NotificationPayload {
  event: NotificationEventName;
  firedAt: string;
  [key: string]: unknown;
}

export interface NotificationQueueHealth {
  configured: boolean;
  workerRunning: boolean;
  workerConnected: boolean;
  queueName: string;
  counts: {
    waiting: number;
    active: number;
    delayed: number;
    completed: number;
    failed: number;
    paused: number;
  };
}

interface NotificationDeliveryJobData {
  deliveryId: string;
  attemptNumber: number;
}

interface QueueNotificationInput {
  channelId: string;
  event: NotificationEventName;
  payload: NotificationPayload;
}

let queueConnection: ConnectionOptions | null = null;
let workerConnection: ConnectionOptions | null = null;
let notificationQueue: Queue<NotificationDeliveryJobData, void, string> | null = null;
let notificationWorker: Worker<NotificationDeliveryJobData, void, string> | null = null;
let workerConnected = false;
let reconciliationTimer: NodeJS.Timeout | null = null;
let reconciliationRunning = false;

function getRedisUrl(): string | null {
  return process.env.REDIS_URL?.trim() || null;
}

function isNotificationQueueConfigured(): boolean {
  return Boolean(getRedisUrl());
}

function createRedisConnection(): ConnectionOptions {
  const redisUrl = getRedisUrl();
  if (!redisUrl) {
    throw new Error('REDIS_URL is required to use the notification queue.');
  }

  return {
    url: redisUrl,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

function getQueueConnection(): ConnectionOptions {
  if (!queueConnection) {
    queueConnection = createRedisConnection();
  }
  return queueConnection;
}

function getWorkerConnection(): ConnectionOptions {
  if (!workerConnection) {
    workerConnection = createRedisConnection();
  }
  return workerConnection;
}

function getNotificationQueue(): Queue<NotificationDeliveryJobData, void, string> {
  if (!notificationQueue) {
    notificationQueue = new Queue<NotificationDeliveryJobData, void, string>(QUEUE_NAME, {
      connection: getQueueConnection(),
    });
  }
  return notificationQueue;
}

function serialiseResponseBody(data: unknown): string | null {
  if (data === undefined || data === null) return null;
  if (typeof data === 'string') return data.slice(0, 4000);

  try {
    return JSON.stringify(data).slice(0, 4000);
  } catch {
    return String(data).slice(0, 4000);
  }
}

function buildEventTitle(event: NotificationEventName): string {
  switch (event) {
    case 'payment_link.paid':
      return 'Payment link paid';
    case 'product.sold_out':
      return 'Product sold out';
    case 'verification.success':
      return 'Verification succeeded';
    case 'verification.failed':
      return 'Verification failed';
    case 'webhook.dead_letter':
      return 'Webhook needs attention';
    case 'notification.test':
      return 'Notification channel test';
  }
}

function buildEventMessage(event: NotificationEventName, payload: NotificationPayload): string {
  switch (event) {
    case 'payment_link.paid':
      return [
        `A payment link was paid${payload.reference ? ` for reference ${String(payload.reference)}` : ''}.`,
        payload.amount ? `Amount: ${String(payload.amount)} ETB.` : null,
        payload.paymentLinkName ? `Link: ${String(payload.paymentLinkName)}.` : null,
      ].filter(Boolean).join(' ');
    case 'product.sold_out':
      return [
        `A product has sold out${payload.productName ? `: ${String(payload.productName)}` : '.'}`,
        payload.productId ? `Product ID: ${String(payload.productId)}.` : null,
      ].filter(Boolean).join(' ');
    case 'verification.success':
      return [
        `A verification succeeded${payload.reference ? ` for reference ${String(payload.reference)}` : ''}.`,
        payload.provider ? `Provider: ${String(payload.provider)}.` : null,
      ].filter(Boolean).join(' ');
    case 'verification.failed':
      return [
        `A verification failed${payload.reference ? ` for reference ${String(payload.reference)}` : ''}.`,
        payload.provider ? `Provider: ${String(payload.provider)}.` : null,
        payload.error ? `Reason: ${String(payload.error)}.` : null,
      ].filter(Boolean).join(' ');
    case 'webhook.dead_letter':
      return [
        `A webhook delivery reached dead letter${payload.webhookUrl ? ` for ${String(payload.webhookUrl)}.` : '.'}`,
        payload.lastError ? `Error: ${String(payload.lastError)}.` : null,
      ].filter(Boolean).join(' ');
    case 'notification.test':
      return 'Your Veritas notification channel is configured and receiving queued deliveries.';
  }
}

function buildEmailHtml(event: NotificationEventName, payload: NotificationPayload): string {
  const title = buildEventTitle(event);
  const message = buildEventMessage(event, payload);

  return `
    <div style="font-family:Arial,sans-serif;background:#060606;color:#f4f4f5;padding:24px">
      <div style="max-width:640px;margin:0 auto;border:1px solid rgba(255,255,255,0.08);border-radius:18px;background:rgba(255,255,255,0.03);padding:24px">
        <p style="margin:0 0 12px;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.45)">Veritas notification</p>
        <h1 style="margin:0 0 12px;font-size:24px;line-height:1.2;color:#ffffff">${title}</h1>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:rgba(255,255,255,0.72)">${message}</p>
        <pre style="white-space:pre-wrap;word-break:break-word;border-radius:14px;background:#0b0b0b;padding:16px;border:1px solid rgba(255,255,255,0.08);color:rgba(255,255,255,0.72);font-size:12px;line-height:1.6;">${JSON.stringify(payload, null, 2)}</pre>
      </div>
    </div>
  `;
}

function buildTelegramText(event: NotificationEventName, payload: NotificationPayload): string {
  const title = buildEventTitle(event);
  const message = buildEventMessage(event, payload);
  const serializedPayload = JSON.stringify(payload, null, 2);
  const text = `${title}\n\n${message}\n\n${serializedPayload}`;

  // Telegram limits messages to 4096 characters.
  return text.length > 3900 ? `${text.slice(0, 3897)}...` : text;
}

async function sendEmail(destination: string, event: NotificationEventName, payload: NotificationPayload) {
  const resendKey = process.env.RESEND_API_KEY?.trim();
  const fromEmail = process.env.VERITAS_NOTIFICATIONS_FROM_EMAIL?.trim();

  if (!resendKey || !fromEmail) {
    throw new Error('RESEND_API_KEY and VERITAS_NOTIFICATIONS_FROM_EMAIL are required for email notifications.');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [destination],
      subject: `Veritas: ${buildEventTitle(event)}`,
      text: buildEventMessage(event, payload),
      html: buildEmailHtml(event, payload),
    }),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Email delivery failed: ${serialiseResponseBody(data) ?? response.statusText}`);
  }

  return data;
}

async function sendTelegram(destination: string, event: NotificationEventName, payload: NotificationPayload) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required for Telegram notifications.');
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: destination,
      text: buildTelegramText(event, payload),
      disable_web_page_preview: true,
    }),
  });

  const data = await response.json().catch(() => null);
  const ok = typeof data === 'object' && data !== null && 'ok' in data ? Boolean((data as { ok: boolean }).ok) : false;
  if (!response.ok || !ok) {
    throw new Error(`Telegram delivery failed: ${serialiseResponseBody(data) ?? response.statusText}`);
  }

  return data;
}

async function deliverNotification(
  type: NotificationChannelType,
  destination: string,
  event: NotificationEventName,
  payload: NotificationPayload,
): Promise<unknown> {
  if (type === 'EMAIL') {
    return sendEmail(destination, event, payload);
  }

  return sendTelegram(destination, event, payload);
}

async function enqueueAttempt(
  deliveryId: string,
  attemptNumber: number,
  delayMs: number,
): Promise<string | null> {
  const job = await getNotificationQueue().add(
    'deliver',
    { deliveryId, attemptNumber },
    {
      delay: delayMs,
      jobId: `${deliveryId}__${attemptNumber}`,
      removeOnComplete: COMPLETED_JOB_RETENTION,
      removeOnFail: FAILED_JOB_RETENTION,
    },
  );

  return job.id?.toString() ?? null;
}

async function markCancelled(deliveryId: string, message: string): Promise<void> {
  await prisma.notificationDelivery.update({
    where: { id: deliveryId },
    data: {
      status: 'CANCELLED',
      success: false,
      lastError: message,
      nextRetryAt: null,
    },
  });
}

async function processNotificationDelivery(job: Job<NotificationDeliveryJobData>): Promise<void> {
  const { deliveryId, attemptNumber } = job.data;

  const delivery = await prisma.notificationDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      channel: {
        select: {
          id: true,
          type: true,
          destination: true,
          active: true,
        },
      },
    },
  });

  if (!delivery) {
    logger.warn(`Notification delivery ${deliveryId} no longer exists. Skipping queued job.`);
    return;
  }

  if (delivery.status === 'SUCCEEDED' || delivery.status === 'CANCELLED') {
    return;
  }

  if (!delivery.channel) {
    await markCancelled(deliveryId, 'Notification channel no longer exists.');
    return;
  }

  if (!delivery.channel.active) {
    await markCancelled(deliveryId, 'Notification channel is inactive.');
    return;
  }

  await prisma.notificationDelivery.update({
    where: { id: deliveryId },
    data: {
      status: 'PROCESSING',
      attempts: Math.max(delivery.attempts, attemptNumber - 1),
      nextRetryAt: null,
      queueJobId: job.id?.toString() ?? delivery.queueJobId ?? null,
    },
  });

  const payload = delivery.payload as unknown as NotificationPayload;

  try {
    const responseData = await deliverNotification(
      delivery.channel.type,
      delivery.channel.destination,
      delivery.event as NotificationEventName,
      payload,
    );

    await prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'SUCCEEDED',
        success: true,
        attempts: attemptNumber,
        responseBody: serialiseResponseBody(responseData),
        lastError: null,
        nextRetryAt: null,
        deliveredAt: new Date(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown notification delivery error';

    if (attemptNumber < MAX_ATTEMPTS) {
      const delayMs = RETRY_DELAYS_MS[attemptNumber - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
      const nextRetryAt = new Date(Date.now() + delayMs);
      const nextJobId = await enqueueAttempt(deliveryId, attemptNumber + 1, delayMs);

      await prisma.notificationDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'RETRYING',
          success: false,
          attempts: attemptNumber,
          lastError: message,
          nextRetryAt,
          queueJobId: nextJobId,
        },
      });

      logger.warn(
        `Notification delivery failed and was requeued [delivery=${deliveryId} attempt=${attemptNumber}] ${message}`,
      );
      return;
    }

    await prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'DEAD_LETTER',
        success: false,
        attempts: attemptNumber,
        lastError: message,
        nextRetryAt: null,
      },
    });

    logger.error(
      `Notification delivery dead-lettered [delivery=${deliveryId} attempt=${attemptNumber}] ${message}`,
    );
  }
}

export async function enqueueNotificationDelivery(
  input: QueueNotificationInput,
): Promise<{ deliveryId: string }> {
  if (!isNotificationQueueConfigured()) {
    throw new Error('Notification queue is not configured. Set REDIS_URL to enable BullMQ.');
  }

  const delivery = await prisma.notificationDelivery.create({
    data: {
      channelId: input.channelId,
      event: input.event,
      payload: input.payload as Prisma.InputJsonValue,
      status: 'QUEUED',
      success: false,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
    },
    select: { id: true },
  });

  const queueJobId = await enqueueAttempt(delivery.id, 1, 0);

  await prisma.notificationDelivery.update({
    where: { id: delivery.id },
    data: { queueJobId },
  });

  return { deliveryId: delivery.id };
}

export async function reconcileNotificationDeliveries(): Promise<number> {
  if (!isNotificationQueueConfigured() || reconciliationRunning) return 0;

  reconciliationRunning = true;
  try {
    const queue = getNotificationQueue();
    const staleBefore = new Date(Date.now() - STALE_DELIVERY_AGE_MS);
    const deliveries = await prisma.notificationDelivery.findMany({
      where: {
        status: { in: ['QUEUED', 'PROCESSING', 'RETRYING'] },
        updatedAt: { lte: staleBefore },
      },
      orderBy: { updatedAt: 'asc' },
      take: 100,
      select: {
        id: true,
        attempts: true,
        maxAttempts: true,
        queueJobId: true,
      },
    });

    let recovered = 0;
    for (const delivery of deliveries) {
      const existingJob = delivery.queueJobId
        ? await queue.getJob(delivery.queueJobId)
        : null;
      const existingState = existingJob ? await existingJob.getState() : null;

      if (existingState && ACTIVE_JOB_STATES.has(existingState)) {
        continue;
      }

      if (delivery.attempts >= delivery.maxAttempts) {
        await prisma.notificationDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'DEAD_LETTER',
            success: false,
            lastError: 'Delivery exhausted its attempts before queue reconciliation.',
            nextRetryAt: null,
          },
        });
        continue;
      }

      if (existingJob) {
        const removed = await existingJob.remove().then(
          () => true,
          (error) => {
            logger.warn(`Could not remove stale notification job ${existingJob.id}: ${String(error)}`);
            return false;
          },
        );
        if (!removed) continue;
      }

      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'QUEUED',
          success: false,
          nextRetryAt: null,
        },
      });

      const attemptNumber = Math.max(1, delivery.attempts + 1);
      const queueJobId = await enqueueAttempt(delivery.id, attemptNumber, 0);
      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: { queueJobId },
      });
      recovered++;
    }

    if (recovered > 0) {
      logger.warn(`Requeued ${recovered} stale notification deliver${recovered === 1 ? 'y' : 'ies'}.`);
    }
    return recovered;
  } finally {
    reconciliationRunning = false;
  }
}

function startNotificationReconciliation(): void {
  if (reconciliationTimer) return;

  reconciliationTimer = setInterval(() => {
    void reconcileNotificationDeliveries().catch((error) => {
      logger.error('Notification delivery reconciliation failed:', error);
    });
  }, RECONCILIATION_INTERVAL_MS);
  reconciliationTimer.unref();
}

export async function startNotificationQueueWorker(): Promise<void> {
  if (!isNotificationQueueConfigured()) {
    throw new Error('Notification queue requires REDIS_URL.');
  }

  if (notificationWorker) return;

  try {
    notificationWorker = new Worker<NotificationDeliveryJobData, void, string>(
      QUEUE_NAME,
      processNotificationDelivery,
      {
        connection: getWorkerConnection(),
        concurrency: Math.max(1, parseInt(process.env.NOTIFICATION_QUEUE_CONCURRENCY ?? '5', 10)),
      },
    );

    notificationWorker.on('error', (error) => {
      workerConnected = false;
      logger.error('Notification queue worker error:', error);
    });

    notificationWorker.on('ready', () => {
      workerConnected = true;
      logger.info('Notification queue worker connected to Redis.');
    });

    notificationWorker.on('closed', () => {
      workerConnected = false;
    });

    notificationWorker.on('failed', (job, error) => {
      logger.error(`Notification queue worker job failed unexpectedly [job=${job?.id ?? 'unknown'}]:`, error);
    });

    await Promise.all([
      getNotificationQueue().waitUntilReady(),
      notificationWorker.waitUntilReady(),
    ]);

    workerConnected = true;
    await reconcileNotificationDeliveries();
    startNotificationReconciliation();
    logger.info('Notification queue worker started.');
  } catch (error) {
    workerConnected = false;
    await stopNotificationQueueWorker().catch(() => undefined);
    throw error;
  }
}

export async function stopNotificationQueueWorker(): Promise<void> {
  if (reconciliationTimer) {
    clearInterval(reconciliationTimer);
    reconciliationTimer = null;
  }

  await notificationWorker?.close();
  notificationWorker = null;
  workerConnected = false;

  await notificationQueue?.close();
  notificationQueue = null;
  workerConnection = null;
  queueConnection = null;
}

export async function getNotificationQueueHealth(): Promise<NotificationQueueHealth> {
  if (!isNotificationQueueConfigured()) {
    return {
      configured: false,
      workerRunning: false,
      workerConnected: false,
      queueName: QUEUE_NAME,
      counts: {
        waiting: 0,
        active: 0,
        delayed: 0,
        completed: 0,
        failed: 0,
        paused: 0,
      },
    };
  }

  const queue = getNotificationQueue();
  const counts = await queue.getJobCounts(
    'waiting',
    'active',
    'delayed',
    'completed',
    'failed',
    'paused',
  );

  return {
    configured: true,
    workerRunning: Boolean(notificationWorker),
    workerConnected,
    queueName: QUEUE_NAME,
    counts: {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      paused: counts.paused ?? 0,
    },
  };
}
