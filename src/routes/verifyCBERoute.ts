import { Router, Request, Response } from 'express';
import { verifyCBE } from '../services/verifyCBE';
import logger from '../utils/logger';
import { extractLegacyCbeUrlData, isLegacyCbeReference, isNewCbeReference } from '../utils/cbeReference';

const router = Router();

interface VerifyRequestBody {
    reference: string;
    accountSuffix?: string;
}

function normalizeCBEReference(reference: string): string {
    return reference.trim();
}

router.post('/', async function (
    req: Request<{}, {}, VerifyRequestBody>,
    res: Response
): Promise<void> {
    const { reference, accountSuffix } = req.body;

    if (!reference || typeof reference !== 'string') {
        res.status(400).json({ success: false, error: 'Missing or invalid reference.' });
        return;
    }

    const normalizedReference = normalizeCBEReference(reference);
    const trimmedSuffix = typeof accountSuffix === 'string' ? accountSuffix.trim() : undefined;

    const hasLegacyLinkData = extractLegacyCbeUrlData(normalizedReference) !== null;
    const isLegacyReference = isLegacyCbeReference(normalizedReference);
    const isNewReference = isNewCbeReference(normalizedReference);

    if (!isLegacyReference && !hasLegacyLinkData && !isNewReference) {
        res.status(400).json({ success: false, error: 'Invalid CBE reference format.' });
        return;
    }

    if (isLegacyReference && !trimmedSuffix) {
        res.status(400).json({ success: false, error: 'Legacy CBE verification requires accountSuffix.' });
        return;
    }

    try {
        const result = await verifyCBE(normalizedReference, trimmedSuffix);
        if (!result.success) {
            res.status(result.statusCode ?? 422).json(result);
            return;
        }
        res.json(result);
    } catch (err) {
        logger.error("💥 Payment verification failed:", err);
        res.status(500).json({ success: false, error: 'Server error verifying payment.' });
    }
});

router.get('/', async function(
    req: Request<{}, {}, {}, { reference?: string; accountSuffix?: string }>,
    res: Response
): Promise<void> {
    const { reference, accountSuffix } = req.query;

    if (typeof reference !== 'string') {
        res.status(400).json({ success: false, error: 'Missing or invalid reference.' });
        return;
    }

    const normalizedReference = normalizeCBEReference(reference);
    const trimmedSuffix = typeof accountSuffix === 'string' ? accountSuffix.trim() : undefined;

    const hasLegacyLinkData = extractLegacyCbeUrlData(normalizedReference) !== null;
    const isLegacyReference = isLegacyCbeReference(normalizedReference);
    const isNewReference = isNewCbeReference(normalizedReference);

    if (!isLegacyReference && !hasLegacyLinkData && !isNewReference) {
        res.status(400).json({ success: false, error: 'Invalid CBE reference format.' });
        return;
    }

    if (isLegacyReference && !trimmedSuffix) {
        res.status(400).json({ success: false, error: 'Legacy CBE verification requires accountSuffix.' });
        return;
    }

    try {
        const result = await verifyCBE(normalizedReference, trimmedSuffix);
        if (!result.success) {
            res.status(result.statusCode ?? 422).json(result);
            return;
        }
        res.json(result);
    } catch (err) {
        logger.error(err);
        res.status(500).json({ success: false, error: 'Server error verifying payment.' });
    }
});

export default router;
