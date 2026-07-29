import { Router, Request, Response } from 'express';

import { prisma } from '../utils/prisma';
import logger from '../utils/logger';
import { WORKSPACE_EVENTS, type WorkspaceEventName } from '../utils/workspaceEvents';
import { getWorkspaceContext } from '../utils/workspaceContext';
import { getBillingConfig } from '../config/billingConfig';
import { getNotificationChannelLimit, type WorkspaceTier } from '../config/plans';
import { enqueueNotificationDelivery } from '../queues/notificationQueue';

const router = Router();

type NotificationChannelType = 'EMAIL' | 'TELEGRAM';

function getWorkspaceId(req: Request): string | null {
  const workspaceContext = getWorkspaceContext(req);
  if (workspaceContext?.workspace.id) {
    return workspaceContext.workspace.id;
  }

  const apiKeyData = (req as any).apiKeyData as { workspaceId?: string } | null;
  return apiKeyData?.workspaceId ?? null;
}

async function getWorkspaceNotificationLimit(req: Request): Promise<number> {
  const tier = (getWorkspaceContext(req)?.workspace.tier ?? 'FREE') as WorkspaceTier;
  return getNotificationChannelLimit(tier, await getBillingConfig());
}

function isValidEvents(events: unknown): events is WorkspaceEventName[] {
  return Array.isArray(events)
    && events.length > 0
    && events.every((event) => (WORKSPACE_EVENTS as readonly string[]).includes(String(event)));
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidTelegramDestination(value: string): boolean {
  return /^@?[a-zA-Z0-9_]{5,}$/.test(value) || /^-?\d{5,}$/.test(value);
}

function validateDestination(type: NotificationChannelType, destination: string): string | null {
  if (type === 'EMAIL') {
    return isValidEmail(destination) ? null : 'Enter a valid email address.';
  }

  return isValidTelegramDestination(destination)
    ? null
    : 'Use a Telegram chat ID like 123456789 or a username like @yourchannel.';
}

router.get('/', async (req: Request, res: Response): Promise<void> => {
  const workspaceId = getWorkspaceId(req);
  if (!workspaceId) {
    res.json({ success: true, channels: [] });
    return;
  }

  try {
    const channels = await prisma.notificationChannel.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      include: {
        deliveries: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            event: true,
            status: true,
            success: true,
            lastError: true,
            deliveredAt: true,
            createdAt: true,
          },
        },
        _count: {
          select: { deliveries: true },
        },
      },
    });

    res.json({
      success: true,
      channels: channels.map((channel) => ({
        id: channel.id,
        type: channel.type,
        label: channel.label,
        destination: channel.destination,
        events: channel.events,
        active: channel.active,
        createdAt: channel.createdAt,
        updatedAt: channel.updatedAt,
        stats: {
          totalDeliveries: channel._count.deliveries,
          lastDelivery: channel.deliveries[0] ?? null,
        },
      })),
      supportedEvents: WORKSPACE_EVENTS,
    });
  } catch (error) {
    logger.error('Failed to list notification channels:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve notifications.' });
  }
});

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const workspaceId = getWorkspaceId(req);
  if (!workspaceId) {
    res.status(400).json({ success: false, error: 'This workspace could not be resolved.' });
    return;
  }

  const { type, label, destination, events } = req.body as {
    type?: NotificationChannelType;
    label?: string;
    destination?: string;
    events?: string[];
  };

  if (type !== 'EMAIL' && type !== 'TELEGRAM') {
    res.status(400).json({ success: false, error: 'type must be EMAIL or TELEGRAM.' });
    return;
  }

  const trimmedDestination = destination?.trim();
  if (!trimmedDestination) {
    res.status(400).json({ success: false, error: 'destination is required.' });
    return;
  }

  const destinationError = validateDestination(type, trimmedDestination);
  if (destinationError) {
    res.status(400).json({ success: false, error: destinationError });
    return;
  }

  if (!isValidEvents(events)) {
    res.status(400).json({
      success: false,
      error: `events must be a non-empty array using supported values: ${WORKSPACE_EVENTS.join(', ')}`,
    });
    return;
  }

  const notificationLimit = await getWorkspaceNotificationLimit(req);
  const activeCount = await prisma.notificationChannel.count({
    where: { workspaceId, active: true },
  });
  if (activeCount >= notificationLimit) {
    res.status(400).json({
      success: false,
      error: `Maximum of ${notificationLimit} active notification channels per workspace.`,
    });
    return;
  }

  try {
    const channel = await prisma.notificationChannel.create({
      data: {
        workspaceId,
        type,
        label: label?.trim() || null,
        destination: trimmedDestination,
        events: events as WorkspaceEventName[],
      },
      select: {
        id: true,
        type: true,
        label: true,
        destination: true,
        events: true,
        active: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.status(201).json({ success: true, channel });
  } catch (error) {
    logger.error('Failed to create notification channel:', error);
    res.status(500).json({ success: false, error: 'Failed to create notification channel.' });
  }
});

router.post('/:id/test', async (req: Request, res: Response): Promise<void> => {
  const workspaceId = getWorkspaceId(req);
  const { id } = req.params;

  if (!workspaceId) {
    res.status(400).json({ success: false, error: 'This workspace could not be resolved.' });
    return;
  }

  try {
    const channel = await prisma.notificationChannel.findFirst({
      where: { id, workspaceId },
      select: { id: true, active: true },
    });

    if (!channel) {
      res.status(404).json({ success: false, error: 'Notification channel not found.' });
      return;
    }
    if (!channel.active) {
      res.status(400).json({ success: false, error: 'Cannot test an inactive notification channel.' });
      return;
    }

    const queued = await enqueueNotificationDelivery({
      channelId: channel.id,
      event: 'notification.test',
      payload: {
        event: 'notification.test',
        firedAt: new Date().toISOString(),
        test: true,
        message: 'This is a test delivery from your Veritas dashboard.',
      },
    });

    res.json({
      success: true,
      deliveryId: queued.deliveryId,
      message: 'Notification test queued for delivery.',
    });
  } catch (error) {
    logger.error('Failed to queue notification test:', error);
    res.status(500).json({ success: false, error: 'Failed to queue notification test.' });
  }
});

router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
  const workspaceId = getWorkspaceId(req);
  const { id } = req.params;

  if (!workspaceId) {
    res.status(400).json({ success: false, error: 'This workspace could not be resolved.' });
    return;
  }

  const { label, destination, events, active } = req.body as {
    label?: string | null;
    destination?: string;
    events?: string[];
    active?: boolean;
  };

  try {
    const existing = await prisma.notificationChannel.findFirst({
      where: { id, workspaceId },
      select: { id: true, type: true, active: true },
    });

    if (!existing) {
      res.status(404).json({ success: false, error: 'Notification channel not found.' });
      return;
    }

    if (active === true && !existing.active) {
      const notificationLimit = await getWorkspaceNotificationLimit(req);
      const activeCount = await prisma.notificationChannel.count({
        where: {
          workspaceId,
          active: true,
          id: { not: id },
        },
      });
      if (activeCount >= notificationLimit) {
        res.status(400).json({
          success: false,
          error: `Maximum of ${notificationLimit} active notification channels per workspace.`,
        });
        return;
      }
    }

    if (destination !== undefined) {
      const trimmedDestination = destination.trim();
      if (!trimmedDestination) {
        res.status(400).json({ success: false, error: 'destination cannot be empty.' });
        return;
      }

      const destinationError = validateDestination(existing.type, trimmedDestination);
      if (destinationError) {
        res.status(400).json({ success: false, error: destinationError });
        return;
      }
    }

    if (events !== undefined && !isValidEvents(events)) {
      res.status(400).json({
        success: false,
        error: `events must be a non-empty array using supported values: ${WORKSPACE_EVENTS.join(', ')}`,
      });
      return;
    }

    if (active !== undefined && typeof active !== 'boolean') {
      res.status(400).json({ success: false, error: 'active must be a boolean.' });
      return;
    }

    const channel = await prisma.notificationChannel.update({
      where: { id },
      data: {
        ...(label !== undefined ? { label: label?.trim() || null } : {}),
        ...(destination !== undefined ? { destination: destination.trim() } : {}),
        ...(events !== undefined ? { events: events as WorkspaceEventName[] } : {}),
        ...(active !== undefined ? { active } : {}),
      },
      select: {
        id: true,
        type: true,
        label: true,
        destination: true,
        events: true,
        active: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json({ success: true, channel });
  } catch (error) {
    logger.error('Failed to update notification channel:', error);
    res.status(500).json({ success: false, error: 'Failed to update notification channel.' });
  }
});

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const workspaceId = getWorkspaceId(req);
  const { id } = req.params;

  if (!workspaceId) {
    res.status(400).json({ success: false, error: 'This workspace could not be resolved.' });
    return;
  }

  try {
    const channel = await prisma.notificationChannel.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });

    if (!channel) {
      res.status(404).json({ success: false, error: 'Notification channel not found.' });
      return;
    }

    await prisma.notificationChannel.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete notification channel:', error);
    res.status(500).json({ success: false, error: 'Failed to delete notification channel.' });
  }
});

export default router;
