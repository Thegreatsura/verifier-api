/**
 * resolveOwner.ts
 *
 * Single source of truth for "which User owns this API key?"
 *
 * Resolution order:
 *   1. apiKeyData.User.id    — the loaded User relation (preferred; set by apiKeyAuth)
 *   2. apiKeyData.userId     — the FK column when the relation isn't included
 *   3. apiKeyData.owner      — legacy string field; treated as a User.id if one matches
 *
 * Returns null for orphaned legacy keys with no User link.
 */

import { prisma } from './prisma';

export async function resolveOwningUserId(apiKeyData: any): Promise<string | null> {
  if (apiKeyData?.User?.id) return apiKeyData.User.id as string;
  if (apiKeyData?.userId) return apiKeyData.userId as string;
  if (apiKeyData?.owner) {
    const u = await prisma.user.findUnique({
      where: { id: apiKeyData.owner as string },
      select: { id: true },
    });
    if (u) return u.id;
  }
  return null;
}
