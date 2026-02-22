import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import logger from '../utils/logger';
import { prisma } from '../utils/prisma';
import { AppError, ErrorType, sendErrorResponse } from '../utils/errorHandler';

// Function to generate a new API key
export const generateApiKey = async (owner: string) => {
  // Generate a secure 24-byte random key
  const rawSecret = crypto.randomBytes(24).toString('hex');
  const rawKey = `sk_live_${rawSecret}`;

  // Hash it for database storage
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  // Create a prefix for the admin dashboard (e.g., sk_live_1a2b3c...)
  const prefix = `sk_live_${rawSecret.substring(0, 6)}...`;

  try {
    // Create API key in database (Notice we do NOT save the rawKey to the 'key' column)
    const apiKey = await prisma.apiKey.create({
      data: {
        keyHash,
        prefix,
        owner,
        usageCount: 0,
        isActive: true,
        tier: 'FREE' // Defaults to free tier
      }
    });

    // Return BOTH the record and the raw key so the admin route can display it once
    return { apiKeyRecord: apiKey, rawKey };
  } catch (error) {
    logger.error('Error generating API key:', error);
    throw error;
  }
};

// Function to validate an API key (Hybrid approach for old & new keys)
export const validateApiKey = async (incomingKey: string) => {
  try {
    const incomingHash = crypto.createHash('sha256').update(incomingKey).digest('hex');

    // We check for the new hashed key OR the legacy plain-text key
    return await prisma.apiKey.findFirst({
      where: {
        isActive: true,
        OR: [
          { keyHash: incomingHash },
          { key: incomingKey } // Keeps your 199 existing users working!
        ]
      }
    });
  } catch (error) {
    logger.error('Error validating API key:', error);
    throw error;
  }
};

// Middleware to check API key
export const apiKeyAuth = async (req: Request, res: Response, next: NextFunction) => {
  // Skip API key check for certain routes
  if (req.path === '/' || req.path === '/health' || req.path.startsWith('/admin')) {
    return next();
  }

  // Get API key from header or query parameter
  const apiKey = req.headers['x-api-key'] || req.query.apiKey as string;

  if (!apiKey) {
    logger.warn(`API request without API key: ${req.method} ${req.path}`);
    return res.status(401).json({ success: false, error: 'API key is required' });
  }

  try {
    // Validate API key
    const keyString = Array.isArray(apiKey) ? apiKey[0] : apiKey;
    const keyData = await validateApiKey(keyString);

    if (!keyData) {
      // Don't log the full invalid key for security
      logger.warn(`Invalid API key attempt.`);
      return res.status(403).json({ success: false, error: 'Invalid API key' });
    }

    // Update API key usage statistics
    await prisma.apiKey.update({
      where: { id: keyData.id },
      data: {
        lastUsed: new Date(),
        usageCount: { increment: 1 }
      }
    });

    // Add API key info to request for later use
    (req as any).apiKeyData = keyData;

    next();
  } catch (error) {
    logger.error('Error validating API key:', error);
    sendErrorResponse(res, error as AppError);
  }
};

// Get all API keys
export const getApiKeys = async () => {
  try {
    return await prisma.apiKey.findMany({
      orderBy: { createdAt: 'desc' } // Good practice to show newest first
    });
  } catch (error) {
    logger.error('Error fetching API keys:', error);
    throw error;
  }
};