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
import paymentLinksRouter from './routes/paymentLinks';
import payoutsRouter from './routes/payouts';
import productsRouter from './routes/products';
import ordersRouter from './routes/orders';
import webhooksRouter from './routes/webhooks';
import notificationsRouter from './routes/notifications';
import adminRouter from './routes/adminRoute';
import internalStatusRouter from './routes/internalStatus';
import logger from './utils/logger';
import { verifyImageHandler } from "./services/verifyImage";
import { requestLogger, initializeStatsCache } from './middleware/requestLogger';
import { apiKeyAuth } from './middleware/apiKeyAuth';
import { rateLimiter } from './middleware/rateLimiter';
import { verifyImageGate, permissionGate, verifyQuotaGate } from './middleware/tierGate';
import { verifyWebhookHook } from './middleware/verifyWebhookHook';
import { getWebhookQueueHealth, startWebhookQueueWorker, stopWebhookQueueWorker } from './queues/webhookQueue';
import { getNotificationQueueHealth, startNotificationQueueWorker, stopNotificationQueueWorker } from './queues/notificationQueue';
import { prisma, disconnectPrisma } from './utils/prisma';

const app = express();
const PORT = process.env.PORT || 3001;
let server: ReturnType<typeof app.listen> | null = null;

const startupState = {
    initializing: true,
    ready: false,
    initializedAt: null as string | null,
    lastError: null as string | null,
};

// Add environment info to startup log
logger.info(`Starting server in ${process.env.NODE_ENV || 'development'} mode`);
logger.info(`Node version: ${process.version}`);
logger.info(`Platform: ${process.platform}`);

async function initializeRuntime(): Promise<void> {
    startupState.initializing = true;
    startupState.ready = false;
    startupState.lastError = null;

    try {
        await prisma.$connect();
        await prisma.$queryRaw`SELECT 1`;
        logger.info('Connected to database successfully');

        await initializeStatsCache();
        await startWebhookQueueWorker();
        await startNotificationQueueWorker();

        startupState.initializing = false;
        startupState.ready = true;
        startupState.initializedAt = new Date().toISOString();
    } catch (error) {
        startupState.initializing = false;
        startupState.ready = false;
        startupState.lastError = error instanceof Error ? error.message : 'Unknown startup error';
        throw error;
    }
}

app.use(cors());
app.use(express.json());

// Add request logging middleware
app.use(requestLogger);

// Register admin routes BEFORE API key authentication
app.use('/admin', adminRouter);

// Signed status probes bypass customer auth, quotas, records, and delivery hooks.
app.use('/internal/status', internalStatusRouter);

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

// Monthly verification quotas (separate from per-minute rate limits)
// Validate batch entitlement/permissions before any quota is deducted.
app.use('/verify-batch', permissionGate('verify-batch'));
app.use('/verify-batch', verifyQuotaGate);
app.use('/verify', verifyQuotaGate);
app.use('/verify-cbe', verifyQuotaGate);
app.use('/verify-telebirr', verifyQuotaGate);
app.use('/verify-dashen', verifyQuotaGate);
app.use('/verify-abyssinia', verifyQuotaGate);
app.use('/verify-cbebirr', verifyQuotaGate);
app.use('/verify-mpesa', verifyQuotaGate);

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
app.use('/verify-batch', batchRouter);
app.use('/verify', universalRouter);
app.use('/products', permissionGate('webhooks'), productsRouter);
app.use('/orders', permissionGate('webhooks'), ordersRouter);
app.use('/payouts', permissionGate('webhooks'), payoutsRouter);
app.use('/payment-links', permissionGate('webhooks'), paymentLinksRouter);
app.use('/webhooks', permissionGate('webhooks'), webhooksRouter);
app.use('/notifications', permissionGate('webhooks'), notificationsRouter);


// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
    res.json({
        status: 'ok',
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
    });
});

app.get('/ready', async (req: Request, res: Response) => {
    const timestamp = new Date().toISOString();

    const checks = {
        startup: {
            initializing: startupState.initializing,
            ready: startupState.ready,
            initializedAt: startupState.initializedAt,
            lastError: startupState.lastError,
        },
        database: {
            ready: false,
            error: null as string | null,
        },
        webhookQueue: {
            ready: false,
            data: null as Awaited<ReturnType<typeof getWebhookQueueHealth>> | null,
            error: null as string | null,
        },
        notificationQueue: {
            ready: false,
            data: null as Awaited<ReturnType<typeof getNotificationQueueHealth>> | null,
            error: null as string | null,
        },
    };

    try {
        await prisma.$queryRaw`SELECT 1`;
        checks.database.ready = true;
    } catch (error) {
        checks.database.error = error instanceof Error ? error.message : 'Database readiness check failed.';
    }

    try {
        const webhookQueue = await getWebhookQueueHealth();
        checks.webhookQueue.data = webhookQueue;
        checks.webhookQueue.ready = webhookQueue.configured && webhookQueue.workerRunning && webhookQueue.workerConnected;
    } catch (error) {
        checks.webhookQueue.error = error instanceof Error ? error.message : 'Webhook queue readiness check failed.';
    }

    try {
        const notificationQueue = await getNotificationQueueHealth();
        checks.notificationQueue.data = notificationQueue;
        checks.notificationQueue.ready = notificationQueue.configured && notificationQueue.workerRunning && notificationQueue.workerConnected;
    } catch (error) {
        checks.notificationQueue.error = error instanceof Error ? error.message : 'Notification queue readiness check failed.';
    }

    const ready =
        checks.startup.ready
        && checks.database.ready
        && checks.webhookQueue.ready
        && checks.notificationQueue.ready;

    res.status(ready ? 200 : 503).json({
        ready,
        timestamp,
        checks,
    });
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
            '/verify-image',
            '/products',
            '/orders',
            '/payment-links',
            '/notifications'
        ]
    });
});

// Global error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

// Graceful shutdown
const gracefulShutdown = async () => {
    logger.info('Shutting down server...');
    if (!server) {
        await stopWebhookQueueWorker();
        await stopNotificationQueueWorker();
        await disconnectPrisma();
        process.exit(0);
        return;
    }

    server.close(async () => {
        logger.info('HTTP server closed');
        await stopWebhookQueueWorker();
        await stopNotificationQueueWorker();
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

async function bootstrap(): Promise<void> {
    try {
        await initializeRuntime();

        server = app.listen(PORT, () => {
            logger.info(`Server running on port ${PORT}`);
        });
    } catch (error) {
        logger.error('Startup failed. Exiting before accepting traffic.', error);
        await stopWebhookQueueWorker().catch(() => undefined);
        await stopNotificationQueueWorker().catch(() => undefined);
        await disconnectPrisma().catch(() => undefined);
        process.exit(1);
    }
}

void bootstrap();
