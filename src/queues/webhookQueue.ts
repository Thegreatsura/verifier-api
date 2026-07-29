import axios from 'axios';
import crypto from 'crypto';
import type { ConnectionOptions, Job } from 'bullmq';
import { Queue, Worker } from 'bullmq';
import { Prisma } from '@prisma/client';
import logger from '../utils/logger';
import { prisma } from '../utils/prisma';
import { emitWorkspaceEvent } from '../utils/workspaceEvents';

const QUEUE_NAME = 'webhook-deliveries';
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000] as const;
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

export interface WebhookPayload {
  event: string;
  [key: string]: unknown;
}

interface WebhookDeliveryJobData {
  deliveryId: string;
  attemptNumber: number;
}

interface QueueDeliveryInput {
  webhookId: string;
  event: string;
  payload: WebhookPayload;
  replayOfDeliveryId?: string | null;
}

export interface WebhookQueueHealth {
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

let queueConnection: ConnectionOptions | null = null;
let workerConnection: ConnectionOptions | null = null;
let deliveryQueue: Queue<WebhookDeliveryJobData, void, string> | null = null;
let deliveryWorker: Worker<WebhookDeliveryJobData, void, string> | null = null;
let workerConnected = false;
let reconciliationTimer: NodeJS.Timeout | null = null;
let reconciliationRunning = false;

function getRedisUrl(): string | null {
  return process.env.REDIS_URL?.trim() || null;
}

function isWebhookQueueConfigured(): boolean {
  return Boolean(getRedisUrl());
}

function createRedisConnection(): ConnectionOptions {
  const redisUrl = getRedisUrl();
  if (!redisUrl) {
    throw new Error('REDIS_URL is required to use the webhook queue.');
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

function getWebhookQueue(): Queue<WebhookDeliveryJobData, void, string> {
  if (!deliveryQueue) {
    deliveryQueue = new Queue<WebhookDeliveryJobData, void, string>(QUEUE_NAME, {
      connection: getQueueConnection(),
    });
  }
  return deliveryQueue;
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

function buildSignature(payload: WebhookPayload, signingSecret: string | null): string | null {
  if (!signingSecret) return null;
  return crypto
    .createHmac('sha256', signingSecret)
    .update(JSON.stringify(payload))
    .digest('hex');
}

async function enqueueAttempt(
  deliveryId: string,
  attemptNumber: number,
  delayMs: number,
): Promise<string | null> {
  const job = await getWebhookQueue().add(
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
  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: 'CANCELLED',
      success: false,
      lastError: message,
      nextRetryAt: null,
    },
  });
}

async function markReplayResolution(
  replayDeliveryId: string,
  originalDeliveryId: string,
  resolvedAt: Date,
): Promise<void> {
  await prisma.webhookDelivery.updateMany({
    where: {
      id: originalDeliveryId,
      status: 'DEAD_LETTER',
      resolvedByReplayId: null,
    },
    data: {
      resolvedByReplayId: replayDeliveryId,
      resolvedAt,
    },
  });
}

async function processWebhookDelivery(job: Job<WebhookDeliveryJobData>): Promise<void> {
  const { deliveryId, attemptNumber } = job.data;

  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      webhook: {
        select: {
          id: true,
          url: true,
          signingSecret: true,
          active: true,
          workspaceId: true,
        },
      },
    },
  });

  if (!delivery) {
    logger.warn(`Webhook delivery ${deliveryId} no longer exists. Skipping queued job.`);
    return;
  }

  if (delivery.status === 'SUCCEEDED' || delivery.status === 'CANCELLED') {
    return;
  }

  if (!delivery.webhook) {
    await markCancelled(deliveryId, 'Webhook record no longer exists.');
    return;
  }

  if (!delivery.webhook.active) {
    await markCancelled(deliveryId, 'Webhook is inactive.');
    return;
  }

  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: 'PROCESSING',
      attempts: Math.max(delivery.attempts, attemptNumber - 1),
      nextRetryAt: null,
      queueJobId: job.id?.toString() ?? delivery.queueJobId ?? null,
    },
  });

  const payload = delivery.payload as unknown as WebhookPayload;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const signature = buildSignature(payload, delivery.webhook.signingSecret);
  if (signature) {
    headers['X-Veritas-Signature'] = `sha256=${signature}`;
  }

  try {
    const response = await axios.post(delivery.webhook.url, payload, {
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    });

    const deliveredAt = new Date();

    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'SUCCEEDED',
        success: true,
        attempts: attemptNumber,
        statusCode: response.status,
        responseBody: serialiseResponseBody(response.data),
        lastError: null,
        nextRetryAt: null,
        deliveredAt,
      },
    });

    if (delivery.replayOfDeliveryId) {
      await markReplayResolution(deliveryId, delivery.replayOfDeliveryId, deliveredAt);
    }

    logger.info(
      `Webhook delivered to ${delivery.webhook.url} [delivery=${deliveryId} attempt=${attemptNumber}] status=${response.status}`,
    );
  } catch (error: unknown) {
    const statusCode = axios.isAxiosError(error) ? (error.response?.status ?? null) : null;
    const responseBody = axios.isAxiosError(error)
      ? serialiseResponseBody(error.response?.data)
      : null;
    const message = error instanceof Error ? error.message : 'Unknown webhook delivery error';

    if (attemptNumber < MAX_ATTEMPTS) {
      const delayMs = RETRY_DELAYS_MS[attemptNumber - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
      const nextRetryAt = new Date(Date.now() + delayMs);
      const nextJobId = await enqueueAttempt(deliveryId, attemptNumber + 1, delayMs);

      await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'RETRYING',
          success: false,
          attempts: attemptNumber,
          statusCode,
          responseBody,
          lastError: message,
          nextRetryAt,
          queueJobId: nextJobId,
        },
      });

      logger.warn(
        `Webhook delivery failed and was requeued [delivery=${deliveryId} attempt=${attemptNumber}] ${message}`,
      );
      return;
    }

    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'DEAD_LETTER',
        success: false,
        attempts: attemptNumber,
        statusCode,
        responseBody,
        lastError: message,
        nextRetryAt: null,
      },
    });

    logger.error(
      `Webhook delivery dead-lettered [delivery=${deliveryId} attempt=${attemptNumber}] ${message}`,
    );

    await emitWorkspaceEvent(delivery.webhook.workspaceId, 'webhook.dead_letter', {
      webhookId: delivery.webhook.id,
      webhookUrl: delivery.webhook.url,
      deliveryId,
      attempts: attemptNumber,
      lastError: message,
    });
  }
}

export async function enqueueWebhookDelivery(
  input: QueueDeliveryInput,
): Promise<{ deliveryId: string }> {
  if (!isWebhookQueueConfigured()) {
    throw new Error('Webhook queue is not configured. Set REDIS_URL to enable BullMQ.');
  }

  const delivery = await prisma.webhookDelivery.create({
    data: {
      webhookId: input.webhookId,
      event: input.event,
      payload: input.payload as Prisma.InputJsonValue,
      status: 'QUEUED',
      success: false,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      replayOfDeliveryId: input.replayOfDeliveryId ?? null,
    },
    select: { id: true },
  });

  const queueJobId = await enqueueAttempt(delivery.id, 1, 0);

  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: { queueJobId },
  });

  return { deliveryId: delivery.id };
}

export async function replayWebhookDelivery(
  webhookId: string,
  deliveryId: string,
): Promise<{ deliveryId: string }> {
  const original = await prisma.webhookDelivery.findFirst({
    where: { id: deliveryId, webhookId },
    select: {
      id: true,
      event: true,
      payload: true,
    },
  });

  if (!original) {
    throw new Error('Webhook delivery record not found.');
  }

  return enqueueWebhookDelivery({
    webhookId,
    event: original.event,
    payload: original.payload as unknown as WebhookPayload,
    replayOfDeliveryId: original.id,
  });
}

export async function reconcileWebhookDeliveries(): Promise<number> {
  if (!isWebhookQueueConfigured() || reconciliationRunning) return 0;

  reconciliationRunning = true;
  try {
    const queue = getWebhookQueue();
    const staleBefore = new Date(Date.now() - STALE_DELIVERY_AGE_MS);
    const deliveries = await prisma.webhookDelivery.findMany({
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
        await prisma.webhookDelivery.update({
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
            logger.warn(`Could not remove stale webhook job ${existingJob.id}: ${String(error)}`);
            return false;
          },
        );
        if (!removed) continue;
      }

      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'QUEUED',
          success: false,
          nextRetryAt: null,
        },
      });

      const attemptNumber = Math.max(1, delivery.attempts + 1);
      const queueJobId = await enqueueAttempt(delivery.id, attemptNumber, 0);
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { queueJobId },
      });
      recovered++;
    }

    if (recovered > 0) {
      logger.warn(`Requeued ${recovered} stale webhook deliver${recovered === 1 ? 'y' : 'ies'}.`);
    }
    return recovered;
  } finally {
    reconciliationRunning = false;
  }
}

function startWebhookReconciliation(): void {
  if (reconciliationTimer) return;

  reconciliationTimer = setInterval(() => {
    void reconcileWebhookDeliveries().catch((error) => {
      logger.error('Webhook delivery reconciliation failed:', error);
    });
  }, RECONCILIATION_INTERVAL_MS);
  reconciliationTimer.unref();
}

export async function getWebhookQueueHealth(): Promise<WebhookQueueHealth> {
  if (!isWebhookQueueConfigured()) {
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

  const queue = getWebhookQueue();
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
    workerRunning: Boolean(deliveryWorker),
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

export async function startWebhookQueueWorker(): Promise<void> {
  if (!isWebhookQueueConfigured()) {
    throw new Error('Webhook queue requires REDIS_URL.');
  }

  if (deliveryWorker) return;

  try {
    deliveryWorker = new Worker<WebhookDeliveryJobData, void, string>(
      QUEUE_NAME,
      processWebhookDelivery,
      {
        connection: getWorkerConnection(),
        concurrency: Math.max(1, parseInt(process.env.WEBHOOK_QUEUE_CONCURRENCY ?? '5', 10)),
      },
    );

    deliveryWorker.on('error', (error) => {
      workerConnected = false;
      logger.error('Webhook queue worker error:', error);
    });

    deliveryWorker.on('ready', () => {
      workerConnected = true;
      logger.info('Webhook queue worker connected to Redis.');
    });

    deliveryWorker.on('closed', () => {
      workerConnected = false;
    });

    deliveryWorker.on('failed', (job, error) => {
      logger.error(`Webhook queue worker job failed unexpectedly [job=${job?.id ?? 'unknown'}]:`, error);
    });

    await Promise.all([
      getWebhookQueue().waitUntilReady(),
      deliveryWorker.waitUntilReady(),
    ]);

    workerConnected = true;
    await reconcileWebhookDeliveries();
    startWebhookReconciliation();
    logger.info('Webhook queue worker started.');
  } catch (error) {
    workerConnected = false;
    await stopWebhookQueueWorker().catch(() => undefined);
    throw error;
  }
}

export async function stopWebhookQueueWorker(): Promise<void> {
  if (reconciliationTimer) {
    clearInterval(reconciliationTimer);
    reconciliationTimer = null;
  }

  await deliveryWorker?.close();
  deliveryWorker = null;
  workerConnected = false;

  await deliveryQueue?.close();
  deliveryQueue = null;
  workerConnection = null;
  queueConnection = null;
}
