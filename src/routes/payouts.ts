/**
 * payouts router
 *
 * GET    /payouts      PRO+ — list payout accounts
 * POST   /payouts      PRO+ — create payout account
 * PATCH  /payouts/:id  PRO+ — update payout account or set default
 * DELETE /payouts/:id  PRO+ — soft delete payout account
 */

import { Prisma } from '@prisma/client';
import { Request, Response, Router } from 'express';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';

const router = Router();

const PHONE_PROVIDERS = ['telebirr', 'cbebirr', 'mpesa'] as const;
const BANK_PROVIDERS = ['cbe', 'dashen', 'abyssinia'] as const;
type PayoutType = 'PHONE' | 'BANK';
type AuthSource = 'DASHBOARD' | 'API_KEY';

const payoutAccountSelect = Prisma.validator<Prisma.PayoutAccountSelect>()({
  id: true,
  label: true,
  accountHolderName: true,
  type: true,
  account: true,
  providersAllowed: true,
  isDefault: true,
  createdAt: true,
  active: true,
});

function getAuthContext(req: Request): {
  workspaceId: string;
  creatorType: AuthSource;
  createdByKeyId: string | null;
} | null {
  const apiKeyData = (req as any).apiKeyData as { id: string; workspaceId: string } | null;
  const workspaceContext = (req as any).workspaceContext as {
    workspace: { id: string };
    source: 'dashboard' | 'api_key';
  } | null;

  if (workspaceContext?.source === 'dashboard') {
    return {
      workspaceId: workspaceContext.workspace.id,
      creatorType: 'DASHBOARD',
      createdByKeyId: null,
    };
  }

  if (apiKeyData) {
    return {
      workspaceId: apiKeyData.workspaceId,
      creatorType: 'API_KEY',
      createdByKeyId: apiKeyData.id,
    };
  }

  return null;
}

function normaliseOptionalLabel(input: unknown): string | null | 'invalid' {
  if (input === undefined) return null;
  if (typeof input !== 'string') return 'invalid';
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalisePayoutType(input: unknown): PayoutType | null {
  if (input === 'PHONE' || input === 'BANK') return input;
  return null;
}

function normaliseAccount(input: unknown): string | 'invalid' {
  if (typeof input !== 'string') return 'invalid';
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : 'invalid';
}

function normaliseProviders(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [
    ...new Set(
      input
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0),
    ),
  ];
}

function isValidPhone(account: string): boolean {
  return /^(09|07)\d{8}$/.test(account) || /^251(9|7)\d{8}$/.test(account);
}

function isValidBankAccount(account: string): boolean {
  return /^\d{13,16}$/.test(account);
}

function validatePayoutInput(
  type: PayoutType,
  account: string,
  providersAllowed: string[],
): string | null {
  if (providersAllowed.length === 0) {
    return 'providersAllowed must include at least one provider.';
  }

  if (type === 'PHONE') {
    if (!isValidPhone(account)) {
      return 'account must be a valid Ethiopian phone number (09/07/251 format).';
    }

    const bad = providersAllowed.filter((provider) => !PHONE_PROVIDERS.includes(provider as (typeof PHONE_PROVIDERS)[number]));
    if (bad.length > 0) {
      return `Phone accounts cannot accept: ${bad.join(', ')}. Valid: ${PHONE_PROVIDERS.join(', ')}.`;
    }
    return null;
  }

  if (!isValidBankAccount(account)) {
    return 'account must be a 13-16 digit bank account number.';
  }

  if (providersAllowed.length !== 1) {
    return 'Bank accounts must be assigned to exactly one bank provider.';
  }

  const bad = providersAllowed.filter((provider) => !BANK_PROVIDERS.includes(provider as (typeof BANK_PROVIDERS)[number]));
  if (bad.length > 0) {
    return `Bank accounts cannot accept: ${bad.join(', ')}. Valid: ${BANK_PROVIDERS.join(', ')}.`;
  }

  return null;
}

router.get('/', async (req: Request, res: Response): Promise<void> => {
  const auth = getAuthContext(req);
  if (!auth) {
    res.status(401).json({ success: false, error: 'Authentication required.' });
    return;
  }

  try {
    const accounts = await prisma.payoutAccount.findMany({
      where: { workspaceId: auth.workspaceId, active: true },
      select: payoutAccountSelect,
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });

    res.json({ success: true, accounts });
  } catch (error) {
    logger.error('Failed to list payout accounts:', error);
    res.status(500).json({ success: false, error: 'Failed to list payout accounts.' });
  }
});

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const auth = getAuthContext(req);
  if (!auth) {
    res.status(401).json({ success: false, error: 'Authentication required.' });
    return;
  }

  const label = normaliseOptionalLabel(req.body?.label);
  if (label === 'invalid' || label === null) {
    res.status(400).json({ success: false, error: 'label is required.' });
    return;
  }

  const accountHolderName = normaliseOptionalLabel(req.body?.accountHolderName);
  if (accountHolderName === 'invalid' || accountHolderName === null) {
    res.status(400).json({ success: false, error: 'accountHolderName is required.' });
    return;
  }

  const type = normalisePayoutType(req.body?.type);
  if (!type) {
    res.status(400).json({ success: false, error: 'type must be PHONE or BANK.' });
    return;
  }

  const account = normaliseAccount(req.body?.account);
  if (account === 'invalid') {
    res.status(400).json({ success: false, error: 'account is required.' });
    return;
  }

  const providersAllowed = normaliseProviders(req.body?.providersAllowed);
  const validationError = validatePayoutInput(type, account, providersAllowed);
  if (validationError) {
    res.status(400).json({ success: false, error: validationError });
    return;
  }

  try {
    const existingCount = await prisma.payoutAccount.count({
      where: { workspaceId: auth.workspaceId, active: true },
    });

    const created = await prisma.payoutAccount.create({
      data: {
        workspaceId: auth.workspaceId,
        label,
        accountHolderName,
        type,
        account,
        providersAllowed,
        isDefault: existingCount === 0,
      },
      select: payoutAccountSelect,
    });

    res.status(201).json({ success: true, account: created });
  } catch (error) {
    logger.error('Failed to create payout account:', error);
    res.status(500).json({ success: false, error: 'Failed to create payout account.' });
  }
});

router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
  const auth = getAuthContext(req);
  if (!auth) {
    res.status(401).json({ success: false, error: 'Authentication required.' });
    return;
  }

  const { id } = req.params;

  try {
    const current = await prisma.payoutAccount.findFirst({
      where: { id, workspaceId: auth.workspaceId, active: true },
      select: payoutAccountSelect,
    });

    if (!current) {
      res.status(404).json({ success: false, error: 'Payout account not found.' });
      return;
    }

    const labelInput = normaliseOptionalLabel(req.body?.label);
    if (labelInput === 'invalid') {
      res.status(400).json({ success: false, error: 'label must be a non-empty string.' });
      return;
    }

    const accountHolderNameInput = normaliseOptionalLabel(req.body?.accountHolderName);
    if (accountHolderNameInput === 'invalid') {
      res.status(400).json({ success: false, error: 'accountHolderName must be a non-empty string.' });
      return;
    }

    const hasProvidersAllowed = req.body?.providersAllowed !== undefined;
    const providersAllowed = hasProvidersAllowed
      ? normaliseProviders(req.body?.providersAllowed)
      : (Array.isArray(current.providersAllowed) ? current.providersAllowed as string[] : []);

    if (hasProvidersAllowed) {
      const validationError = validatePayoutInput(current.type as PayoutType, current.account, providersAllowed);
      if (validationError) {
        res.status(400).json({ success: false, error: validationError });
        return;
      }
    }

    const nextLabel = labelInput ?? current.label;
    const nextAccountHolderName = accountHolderNameInput ?? current.accountHolderName;
    const markDefault = req.body?.isDefault === true;

    if (markDefault) {
      await prisma.$transaction([
        prisma.payoutAccount.updateMany({
          where: { workspaceId: auth.workspaceId, isDefault: true },
          data: { isDefault: false },
        }),
        prisma.payoutAccount.update({
          where: { id },
          data: {
            isDefault: true,
            label: nextLabel,
            accountHolderName: nextAccountHolderName,
            ...(hasProvidersAllowed ? { providersAllowed } : {}),
          },
        }),
      ]);
    } else {
      await prisma.payoutAccount.update({
        where: { id },
        data: {
          label: nextLabel,
          accountHolderName: nextAccountHolderName,
          ...(hasProvidersAllowed ? { providersAllowed } : {}),
        },
      });
    }

    const updated = await prisma.payoutAccount.findUnique({
      where: { id },
      select: payoutAccountSelect,
    });

    res.json({ success: true, account: updated });
  } catch (error) {
    logger.error('Failed to update payout account:', error);
    res.status(500).json({ success: false, error: 'Failed to update payout account.' });
  }
});

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const auth = getAuthContext(req);
  if (!auth) {
    res.status(401).json({ success: false, error: 'Authentication required.' });
    return;
  }

  const { id } = req.params;

  try {
    const target = await prisma.payoutAccount.findFirst({
      where: { id, workspaceId: auth.workspaceId, active: true },
      select: { id: true, isDefault: true },
    });

    if (!target) {
      res.status(404).json({ success: false, error: 'Payout account not found.' });
      return;
    }

    const promote = target.isDefault
      ? await prisma.payoutAccount.findFirst({
          where: { workspaceId: auth.workspaceId, active: true, id: { not: id } },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        })
      : null;

    await prisma.$transaction([
      prisma.payoutAccount.update({
        where: { id },
        data: { active: false, isDefault: false },
      }),
      ...(promote
        ? [prisma.payoutAccount.update({ where: { id: promote.id }, data: { isDefault: true } })]
        : []),
    ]);

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete payout account:', error);
    res.status(500).json({ success: false, error: 'Failed to delete payout account.' });
  }
});

export default router;
