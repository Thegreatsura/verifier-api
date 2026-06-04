import { Router, Request, Response } from 'express';
import { runSmartVerify } from '../services/verifyUniversal';
import logger from '../utils/logger';

const router = Router();

interface UniversalVerifyBody {
    reference: string;
    suffix?: string;
    phoneNumber?: string;
}

router.post('/', async (req: Request<{}, {}, UniversalVerifyBody>, res: Response): Promise<void> => {
    const { reference, suffix, phoneNumber } = req.body;

    if (!reference || typeof reference !== 'string') {
        res.status(400).json({ success: false, error: 'Missing or invalid reference.' });
        return;
    }

    // Pull raw key for CBE Birr (needs it to authenticate sub-requests)
    const apiKey = req.headers['x-api-key'] as string | undefined
        ?? req.headers.authorization?.replace('Bearer ', '');

    const result = await runSmartVerify({ reference, suffix, phoneNumber, apiKey });

    if (!result.success) {
        logger.warn(`Universal verify failed [${result.httpStatus}]: ${result.error}`);
        res.status(result.httpStatus).json({
            success: false,
            error: result.error,
            ...(result.details ? { details: result.details } : {}),
        });
        return;
    }

    // Telebirr wraps its result in { success, data } already; other providers return the object directly.
    // Preserve existing response shape: if data has a `success` field, forward as-is, otherwise wrap.
    const responseBody = (result.data as any)?.success !== undefined
        ? result.data
        : { success: true, data: result.data };

    res.json(responseBody);
});

export default router;
