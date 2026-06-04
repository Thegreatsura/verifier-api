import express, { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

import CBERouter from './routes/verifyCBERoute';
import telebirrRouter from './routes/verifyTelebirrRoute';
import dashenRouter from './routes/verifyDashenRoute';
import abyssiniaRouter from './routes/verifyAbyssiniaRoute';
import cbebirrRouter from './routes/verifyCBEBirrRoute';
import mpesaRouter from './routes/verifyMpesaRoute';
import universalRouter from './routes/verifyUniversalRoute';
import batchRouter from './routes/verifyBatch';
import checkoutRouter from './routes/checkout';
import webhooksRouter from './routes/webhooks';
import adminRouter from './routes/adminRoute';
import logger from './utils/logger';
import { verifyImageHandler } from "./services/verifyImage";
import { requestLogger, initializeStatsCache } from './middleware/requestLogger';
import { apiKeyAuth } from './middleware/apiKeyAuth';
import { rateLimiter } from './middleware/rateLimiter';
import { verifyImageGate, permissionGate } from './middleware/tierGate';
import { verifyWebhookHook } from './middleware/verifyWebhookHook';
import { prisma, disconnectPrisma } from './utils/prisma';

const app = express();
const PORT = process.env.PORT || 3001;

// Add environment info to startup log
logger.info(`Starting server in ${process.env.NODE_ENV || 'development'} mode`);
logger.info(`Node version: ${process.version}`);
logger.info(`Platform: ${process.platform}`);

// Initialize database connection and cache
(async () => {
    try {
        // Test database connection
        await prisma.$connect();
        logger.info('Connected to database successfully');

        // Initialize stats cache from database
        await initializeStatsCache();
    } catch (error) {
        logger.error('Failed to initialize database connection or stats cache. Starting server anyway...', error);
    }
})();

app.use(cors());
app.use(express.json());

// Add request logging middleware
app.use(requestLogger);

// Register admin routes BEFORE API key authentication
app.use('/admin', adminRouter);

// Add API key authentication middleware (will not affect admin routes)
app.use(apiKeyAuth as express.RequestHandler);

// Capture verify-endpoint responses so we can fire registered webhooks
// after the response is sent. No-op on non-verify paths.
app.use(verifyWebhookHook);

// Rate limiting on all verify routes (applied after auth so apiKeyData is available)
app.use('/verify-batch', rateLimiter);
app.use('/verify', rateLimiter);
app.use('/verify-cbe', rateLimiter);
app.use('/verify-telebirr', rateLimiter);
app.use('/verify-dashen', rateLimiter);
app.use('/verify-abyssinia', rateLimiter);
app.use('/verify-cbebirr', rateLimiter);
app.use('/verify-mpesa', rateLimiter);
app.use('/verify-image', rateLimiter);

// Error handling for JSON parsing - properly typed as an error handler
const jsonErrorHandler: ErrorRequestHandler = async (err, req, res, next): Promise<void> => {
    if (err instanceof SyntaxError && 'body' in err) {
        logger.error('JSON parsing error:', err);
        res.status(400).json({ success: false, error: 'Invalid JSON in request body' });
        return;
    }
    next(err);
};

app.use(jsonErrorHandler);

// ✅ Attach routers to paths
app.use('/verify-cbe', CBERouter);
app.use('/verify-telebirr', telebirrRouter);
app.use('/verify-dashen', dashenRouter);
app.use('/verify-abyssinia', abyssiniaRouter);
app.use('/verify-cbebirr', cbebirrRouter);
app.use('/verify-mpesa', mpesaRouter);
app.post('/verify-image', verifyImageGate, verifyImageHandler);
app.use('/verify-batch', permissionGate('verify-batch'), batchRouter);
app.use('/verify', universalRouter);
app.use('/checkout', permissionGate('webhooks'), checkoutRouter);   // checkout is a PRO+ feature
app.use('/webhooks', permissionGate('webhooks'), webhooksRouter);


// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Root endpoint
app.get('/', (req: Request, res: Response) => {
    res.json({
        name: 'Payment Verification API',
        version: '3.0.3',
        endpoints: [
            '/verify-cbe',
            '/verify-telebirr',
            '/verify-dashen',
            '/verify-abyssinia',
            '/verify-cbebirr',
            '/verify-mpesa',
            '/verify',
            '/verify-image'
        ]
    });
});

// Global error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

// Start the server
const server = app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
});

// Graceful shutdown
const gracefulShutdown = async () => {
    logger.info('Shutting down server...');
    server.close(async () => {
        logger.info('HTTP server closed');
        await disconnectPrisma();
        process.exit(0);
    });

    // Force close after 10 seconds
    setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
    }, 10000);
};

// Listen for termination signals
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
