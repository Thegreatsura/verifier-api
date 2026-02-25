import { Router, Request, Response } from 'express';
import { verifyCBE } from '../services/verifyCBE';
import { verifyTelebirr } from '../services/verifyTelebirr';
import { verifyDashen } from '../services/verifyDashen';
import { verifyAbyssinia } from '../services/verifyAbyssinia';
import { verifyCBEBirr } from '../services/verifyCBEBirr';
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

    const trimmedRef = reference.trim();
    const len = trimmedRef.length;

    // Reject immediately if the length does not match any known provider
    if (len !== 10 && len !== 12 && len !== 16) {
        res.status(400).json({ success: false, error: 'Invalid reference length for automatic sorting.' });
        return;
    }

    try {
        // --- DASHEN BANK ---
        // 16 characters, starts with 3 digits
        if (len === 16 && /^\d{3}/.test(trimmedRef)) {
            // Check for extraneous parameters
            if (suffix || phoneNumber) {
                res.status(400).json({ success: false, error: 'Dashen bank verification expects only a reference number. Exclude suffix and phoneNumber.' });
                return;
            }

            const result = await verifyDashen(trimmedRef);
            res.json(result);
            return;
        }

        // --- CBE & ABYSSINIA ---
        // 12 characters, starts with 'FT'
        else if (len === 12 && trimmedRef.toUpperCase().startsWith('FT')) {
            if (!suffix) {
                res.status(400).json({ success: false, error: 'Transactions starting with "FT" require a suffix (8 digits for CBE, 5 digits for Abyssinia).' });
                return;
            }

            const trimmedSuffix = suffix.trim();

            if (trimmedSuffix.length === 8) {
                // CBE
                const result = await verifyCBE(trimmedRef, trimmedSuffix);
                res.json(result);
                return;
            } else if (trimmedSuffix.length === 5) {
                // Abyssinia
                const result = await verifyAbyssinia(trimmedRef, trimmedSuffix);
                res.json(result);
                return;
            } else {
                res.status(400).json({ success: false, error: 'Suffix must be exactly 8 digits (CBE) or 5 digits (Abyssinia).' });
                return;
            }
        }

        // --- CBE BIRR & TELEBIRR ---
        // 10 alphanumeric characters
        else if (len === 10) {
            // Must be strictly alphanumeric
            if (!/^[A-Za-z0-9]{10}$/.test(trimmedRef)) {
                res.status(400).json({ success: false, error: '10-character reference must be alphanumeric.' });
                return;
            }

            // Strictly forbid a suffix here
            if (suffix) {
                res.status(400).json({ success: false, error: 'Suffix is not expected for 10-character transactions.' });
                return;
            }

            if (phoneNumber) {
                // CBE Birr Verification
                const trimmedPhone = phoneNumber.trim();

                // Basic Ethiopian Phone Number Validation check
                if (!trimmedPhone.startsWith('251') || trimmedPhone.length > 12 || trimmedPhone.length < 10) {
                    res.status(400).json({ success: false, error: 'Invalid phone number format. Must start with 251 and be 12 digits long.' });
                    return;
                }

                const apiKey = req.headers.authorization?.replace('Bearer ', '') || req.headers['x-api-key'] as string;
                if (!apiKey) {
                    res.status(401).json({ success: false, error: 'API key is required in Authorization header or x-api-key header for CBE Birr' });
                    return;
                }

                const result = await verifyCBEBirr(trimmedRef, trimmedPhone, apiKey);
                res.json(result);
                return;
            } else {
                // Telebirr Verification (No phone number provided)
                const result = await verifyTelebirr(trimmedRef);
                if (!result) {
                    res.status(404).json({ success: false, error: 'Receipt not found or could not be processed.' });
                    return;
                }
                res.json({ success: true, data: result });
                return;
            }
        }

        // If none of the conditions above caught the request, it doesn't match a known format
        res.status(400).json({ success: false, error: 'The provided reference does not match any recognized provider format for automatic sorting.' });
        return;

    } catch (err: any) {
        logger.error("💥 Universal verification failed:", err);

        if (err.name === 'TelebirrVerificationError') {
            res.status(502).json({
                success: false,
                error: err.message,
                details: err.details
            });
            return;
        }

        res.status(500).json({
            success: false,
            error: 'Server error verifying payment through the universal endpoint.',
            message: err instanceof Error ? err.message : 'Unknown error'
        });
    }
});

export default router;
