import { Router, Request, Response } from 'express';
import { verifyCBE } from '../services/verifyCBE';
import logger from '../utils/logger';

const router = Router();

interface VerifyRequestBody {
    reference: string;
    accountSuffix?: string;
}

function normalizeCBEReference(reference: string): string {
    return reference.trim();
}

function isLegacyCBEReference(reference: string): boolean {
    return reference.length === 12 && reference.toUpperCase().startsWith('FT');
}

function isNewCBEReference(reference: string): boolean {
    return /^https?:\/\/mbreciept\.cbe\.com\.et\/[A-Za-z0-9]+\/?$/i.test(reference)
        || (!reference.toUpperCase().startsWith('FT') && /^[A-Za-z0-9]{15,25}$/.test(reference));
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

    if (!isLegacyCBEReference(normalizedReference) && !isNewCBEReference(normalizedReference)) {
        res.status(400).json({ success: false, error: 'Invalid CBE reference format.' });
        return;
    }

    if (isLegacyCBEReference(normalizedReference) && !trimmedSuffix) {
        res.status(400).json({ success: false, error: 'Legacy CBE verification requires accountSuffix.' });
        return;
    }

    try {
        const result = await verifyCBE(normalizedReference, trimmedSuffix);
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

    if (!isLegacyCBEReference(normalizedReference) && !isNewCBEReference(normalizedReference)) {
        res.status(400).json({ success: false, error: 'Invalid CBE reference format.' });
        return;
    }

    if (isLegacyCBEReference(normalizedReference) && !trimmedSuffix) {
        res.status(400).json({ success: false, error: 'Legacy CBE verification requires accountSuffix.' });
        return;
    }

    try {
        const result = await verifyCBE(normalizedReference, trimmedSuffix);
        res.json(result);
    } catch (err) {
        logger.error(err);
        res.status(500).json({ success: false, error: 'Server error verifying payment.' });
    }
});

export default router;
