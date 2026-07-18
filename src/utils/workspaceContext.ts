/**
 * workspaceContext.ts
 *
 * Unified resolver for getting workspace context from either:
 * - dashboard auth (req.workspaceContext)
 * - traditional API key auth (req.apiKeyData.workspace)
 */

import { Request } from 'express';

export interface WorkspaceContext {
    workspace: {
        id: string;
        tier: 'FREE' | 'PRO' | 'BUSINESS';
        grandfathered: boolean;
        verificationCredits: number;
        verificationCreditsMonthly: number;
        verificationCreditsResetAt: Date | null;
        paidUntil: Date | null;
        planTermMonths: number | null;
        imageCredits: number;
        imageCreditsMonthly: number;
        imageCreditsResetAt: Date | null;
    };
    source: 'dashboard' | 'api_key';
}

/**
 * Get workspace context from request.
 * Returns null if no workspace context is available.
 */
export function getWorkspaceContext(req: Request): WorkspaceContext | null {
    // Check for dashboard auth first
    const dashboardContext = (req as any).workspaceContext;
    if (dashboardContext?.workspace) {
        return {
            workspace: dashboardContext.workspace,
            source: 'dashboard' as const,
        };
    }

    // Check for traditional API key auth
    const apiKeyData = (req as any).apiKeyData;
    if (apiKeyData?.workspace) {
        return {
            workspace: apiKeyData.workspace,
            source: 'api_key' as const,
        };
    }

    return null;
}

/**
 * Get workspace ID from request.
 * Returns null if no workspace context is available.
 */
export function getWorkspaceId(req: Request): string | null {
    const context = getWorkspaceContext(req);
    return context?.workspace.id ?? null;
}

/**
 * Get workspace tier from request.
 * Returns 'FREE' as default if no workspace context is available.
 */
export function getWorkspaceTier(req: Request): 'FREE' | 'PRO' | 'BUSINESS' {
    const context = getWorkspaceContext(req);
    return context?.workspace.tier ?? 'FREE';
}
