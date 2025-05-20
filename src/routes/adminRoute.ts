import { Router, Request, Response, RequestHandler, NextFunction } from 'express';
import { generateApiKey, getApiKeys } from '../middleware/apiKeyAuth';
import { getUsageStats } from '../middleware/requestLogger';
import logger from '../utils/logger';

const router = Router();

// Admin secret key for authentication (use environment variable in production)
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-this-secret-key';

// Middleware to check admin authentication
const checkAdminAuth = (req: Request, res: Response, next: NextFunction) => {
    const adminKey = req.headers['x-admin-key'] || req.query.adminKey;

    if (adminKey !== ADMIN_SECRET) {
        return res.status(403).json({ success: false, error: 'Unauthorized admin access' });
    }

    next();
};

// Generate a new API key
// Update the API key generation route
router.post('/api-keys', checkAdminAuth as RequestHandler, async (req: Request, res: Response): Promise<void> => {
    const { owner } = req.body;

    if (!owner) {
        res.status(400).json({ success: false, error: 'Owner name is required' });
        return;
    }

    try {
        const apiKey = await generateApiKey(owner);
        logger.info(`New API key generated for ${owner}`);

        res.status(201).json({
            success: true,
            data: {
                key: apiKey.key,
                owner: apiKey.owner,
                createdAt: apiKey.createdAt
            }
        });
    } catch (err) {
        logger.error('Error generating API key:', err);
        res.status(500).json({ success: false, error: 'Failed to generate API key' });
    }
});

// Update the API keys listing route
router.get('/api-keys', checkAdminAuth as RequestHandler, async (req: Request, res: Response) => {
    try {
        const apiKeys = await getApiKeys();
        const keyList = apiKeys.map((key: {
            key: string;
            owner: string;
            createdAt: Date;
            lastUsed: Date | null;
            usageCount: number;
            isActive: boolean;
        }) => ({
            key: key.key.substring(0, 8) + '...',
            owner: key.owner,
            createdAt: key.createdAt,
            lastUsed: key.lastUsed,
            usageCount: key.usageCount,
            isActive: key.isActive
        }));

        res.json({ success: true, data: keyList });
    } catch (err) {
        logger.error('Error fetching API keys:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch API keys' });
    }
});

// Update the stats route
router.get('/stats', checkAdminAuth as RequestHandler, async (req: Request, res: Response) => {
    try {
        const stats = await getUsageStats();
        res.json({
            success: true,
            data: stats
        });
    } catch (err) {
        logger.error('Error fetching usage stats:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch usage statistics' });
    }
});

export default router;