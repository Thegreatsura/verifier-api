import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import { prisma } from '../utils/prisma';

// In-memory cache for quick stats access
const statsCache = {
  totalRequests: 0,
  endpointStats: new Map<string, {
    count: number,
    successCount: number,
    failureCount: number,
    avgResponseTime: number
  }>(),
  ipStats: new Map<string, number>()
};

// Initialize cache from database on startup
export const initializeStatsCache = async () => {
  try {
    // Get total requests
    statsCache.totalRequests = await prisma.usageLog.count();

    // Get endpoint stats
    const endpointStats = await prisma.$queryRaw`
      SELECT 
        CONCAT(method, ' ', endpoint) as endpoint,
        COUNT(*) as count,
        SUM(CASE WHEN statusCode < 400 THEN 1 ELSE 0 END) as successCount,
        SUM(CASE WHEN statusCode >= 400 THEN 1 ELSE 0 END) as failureCount,
        AVG(responseTime) as avgResponseTime
      FROM UsageLog
      GROUP BY method, endpoint
    `;

    // Populate cache
    if (Array.isArray(endpointStats)) {
      endpointStats.forEach((stat: any) => {
        statsCache.endpointStats.set(stat.endpoint, {
          count: Number(stat.count),
          successCount: Number(stat.successCount),
          failureCount: Number(stat.failureCount),
          avgResponseTime: Number(stat.avgResponseTime)
        });
      });
    }

    // Get IP stats
    const ipStats = await prisma.$queryRaw`
      SELECT ip, COUNT(*) as count
      FROM UsageLog
      GROUP BY ip
    `;

    if (Array.isArray(ipStats)) {
      ipStats.forEach((stat: any) => {
        statsCache.ipStats.set(stat.ip, Number(stat.count));
      });
    }

    logger.info('Stats cache initialized from database');
  } catch (error) {
    logger.error('Error initializing stats cache:', error);
  }
};

export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const requestId = Math.random().toString(36).substring(2, 15);

  // Log request details
  logger.info(`[${requestId}] Incoming ${req.method} request to ${req.originalUrl}`, {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.get('user-agent'),
    body: req.method === 'POST' ? JSON.stringify(req.body) : undefined,
    query: Object.keys(req.query).length ? req.query : undefined,
    apiKeyOwner: (req as any).apiKeyData ? (req as any).apiKeyData.owner : 'none'
  });

  // Update in-memory cache for quick access
  statsCache.totalRequests++;

  // Track by endpoint
  const endpoint = `${req.method} ${req.originalUrl.split('?')[0]}`;
  if (!statsCache.endpointStats.has(endpoint)) {
    statsCache.endpointStats.set(endpoint, {
      count: 0,
      successCount: 0,
      failureCount: 0,
      avgResponseTime: 0
    });
  }
  const endpointStat = statsCache.endpointStats.get(endpoint)!;
  endpointStat.count++;

  // Track by IP address
  const ipCount = statsCache.ipStats.get(req.ip ?? '') || 0;
  statsCache.ipStats.set(req.ip ?? '', ipCount + 1);

  // Use the 'finish' event to capture response completion
  res.on('finish', async () => {
    const responseTime = Date.now() - start;
    const endpointStat = statsCache.endpointStats.get(endpoint)!;

    if (res.statusCode < 400) {
      endpointStat.successCount++;
    } else {
      endpointStat.failureCount++;
    }

    endpointStat.avgResponseTime =
      (endpointStat.avgResponseTime * (endpointStat.count - 1) + responseTime) / endpointStat.count;

    // Get a safe representation of the key for logging (prefix or legacy substring)
    const keyDetails = (req as any).apiKeyData;
    const safeKeyLog = keyDetails ? (keyDetails.prefix || (keyDetails.key ? keyDetails.key.substring(0, 8) : 'unknown')) : 'none';

    logger.info(`[${requestId}] Response sent in ${responseTime}ms with status ${res.statusCode}`, {
      statusCode: res.statusCode,
      responseTime,
      contentLength: res.get('Content-Length') || 'unknown',
      apiKey: safeKeyLog
    });

    if (res.statusCode >= 400) {
      logger.warn(`[${requestId}] Error occurred with status ${res.statusCode}`);
    }

    // Store usage log in database if API key is present
    try {
      if ((req as any).apiKeyData) {
        await prisma.usageLog.create({
          data: {
            apiKeyId: (req as any).apiKeyData.id,
            endpoint,
            method: req.method,
            statusCode: res.statusCode,
            responseTime,
            ip: req.ip || 'unknown'
          }
        });
      }
    } catch (error) {
      logger.error('Error logging API usage:', error);
    }
  });

  next();
};

// Get usage statistics with cache fallback
export const getUsageStats = async () => {
  try {
    // Try to get fresh data from database
    const totalLogs = await prisma.usageLog.count();

    const endpointStats = await prisma.$queryRaw`
      SELECT 
        CONCAT(method, ' ', endpoint) as endpoint,
        COUNT(*) as count,
        SUM(CASE WHEN statusCode < 400 THEN 1 ELSE 0 END) as successCount,
        SUM(CASE WHEN statusCode >= 400 THEN 1 ELSE 0 END) as failureCount,
        AVG(responseTime) as avgResponseTime
      FROM UsageLog
      GROUP BY method, endpoint
    `;

    const ipStats = await prisma.$queryRaw`
      SELECT ip, COUNT(*) as count
      FROM UsageLog
      GROUP BY ip
    `;

    // Convert raw results to proper format
    const formattedEndpointStats: Record<string, any> = {};
    if (Array.isArray(endpointStats)) {
      endpointStats.forEach((stat: any) => {
        formattedEndpointStats[stat.endpoint] = {
          count: Number(stat.count),
          successCount: Number(stat.successCount),
          failureCount: Number(stat.failureCount),
          avgResponseTime: Number(stat.avgResponseTime)
        };
      });
    }

    const formattedIpStats: Record<string, number> = {};
    if (Array.isArray(ipStats)) {
      ipStats.forEach((stat: any) => {
        formattedIpStats[stat.ip] = Number(stat.count);
      });
    }

    return {
      totalRequests: totalLogs,
      endpointStats: formattedEndpointStats,
      ipStats: formattedIpStats
    };
  } catch (error) {
    logger.error('Error fetching usage stats from database:', error);

    // Fallback to in-memory cache if database query fails
    logger.info('Falling back to in-memory cache for stats');

    // Convert Maps to objects for JSON serialization
    const endpointStatsObj: Record<string, any> = {};
    statsCache.endpointStats.forEach((value, key) => {
      endpointStatsObj[key] = value;
    });

    const ipStatsObj: Record<string, number> = {};
    statsCache.ipStats.forEach((value, key) => {
      ipStatsObj[key] = value;
    });

    return {
      totalRequests: statsCache.totalRequests,
      endpointStats: endpointStatsObj,
      ipStats: ipStatsObj
    };
  }
};