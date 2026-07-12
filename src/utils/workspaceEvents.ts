import { prisma } from './prisma';
import { enqueueNotificationDelivery } from '../queues/notificationQueue';
import { fireRegisteredWebhook } from './fireWebhook';
import logger from './logger';

export const WORKSPACE_EVENTS = [
    'payment_link.paid',
    'product.sold_out',
    'verification.success',
    'verification.failed',
    'webhook.dead_letter',
] as const;

export type WorkspaceEventName = (typeof WORKSPACE_EVENTS)[number];

export interface WorkspaceEventPayload {
    event: WorkspaceEventName;
    firedAt: string;
    [key: string]: unknown;
}

export async function emitWorkspaceEvent(
    workspaceId: string,
    event: WorkspaceEventName,
    payload: Record<string, unknown>,
): Promise<void> {
    try {
        const [webhooks, notificationChannels] = await Promise.all([
            prisma.webhook.findMany({
                where: { workspaceId, active: true },
                select: { id: true, url: true, signingSecret: true, events: true },
            }),
            prisma.notificationChannel.findMany({
                where: { workspaceId, active: true },
                select: { id: true, events: true },
            }),
        ]);

        const eventPayload: WorkspaceEventPayload = {
            event,
            firedAt: new Date().toISOString(),
            ...payload,
        };

        for (const webhook of webhooks) {
            const events = Array.isArray(webhook.events) ? (webhook.events as string[]) : [];
            if (!events.includes(event)) continue;

            fireRegisteredWebhook(webhook.id, webhook.signingSecret, webhook.url, eventPayload);
        }

        for (const channel of notificationChannels) {
            const events = Array.isArray(channel.events) ? (channel.events as string[]) : [];
            if (!events.includes(event)) continue;

            void enqueueNotificationDelivery({
                channelId: channel.id,
                event,
                payload: eventPayload,
            }).catch((error) => {
                logger.error(`Failed to enqueue notification channel ${channel.id}:`, error);
            });
        }
    } catch (error) {
        logger.error(`Failed to emit workspace event ${event} for workspace ${workspaceId}:`, error);
    }
}
