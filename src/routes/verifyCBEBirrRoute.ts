import { Router, Request, Response } from 'express';
import { verifyCBEBirr } from '../services/verifyCBEBirr';
import logger from '../utils/logger';

const router = Router();

// Validation helper for Ethiopian phone numbers
function isValidEthiopianPhone(phone: string): boolean {
  // Ethiopian phone numbers should start with 251 and be 12 digits total
  const phoneRegex = /^251\d{9}$/;
  return phoneRegex.test(phone);
}

// POST endpoint for CBE Birr verification
router.post('/', async (req: Request, res: Response) => {
  try {
    const { receiptNumber, phoneNumber } = req.body;
    const apiKey = req.headers.authorization?.replace('Bearer ', '') || req.headers['x-api-key'] as string;

    // Validate required parameters
    if (!receiptNumber) {
      res.status(400).json({
        success: false,
        error: 'Receipt number is required'
      });
      return;
    }

    if (!phoneNumber) {
      res.status(400).json({
        success: false,
        error: 'Phone number is required'
      });
      return;
    }

    if (!apiKey) {
      res.status(401).json({
        success: false,
        error: 'API key is required in Authorization header or x-api-key header'
      });
      return;
    }

    // Validate Ethiopian phone number format
    if (!isValidEthiopianPhone(phoneNumber)) {
      res.status(400).json({
        success: false,
        error: 'Invalid Ethiopian phone number format. Must start with 251 and be 12 digits total'
      });
      return;
    }

    logger.info(`[CBEBirr Route] Processing verification request for receipt: ${receiptNumber}, phone: ${phoneNumber}`);

    // Call the verification service
    const result = await verifyCBEBirr(receiptNumber, phoneNumber, apiKey);

    // Return the result
    res.json(result);

  } catch (error) {
    logger.error('[CBEBirr Route] Error in POST endpoint:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// GET endpoint for CBE Birr verification (alternative method)
router.get('/', async (req: Request, res: Response) => {
  try {
    const { receiptNumber, phoneNumber } = req.query;
    const apiKey = req.headers.authorization?.replace('Bearer ', '') || req.headers['x-api-key'] as string;

    // Validate required parameters
    if (!receiptNumber || typeof receiptNumber !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Receipt number is required as query parameter'
      });
      return;
    }

    if (!phoneNumber || typeof phoneNumber !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Phone number is required as query parameter'
      });
      return;
    }

    if (!apiKey) {
      res.status(401).json({
        success: false,
        error: 'API key is required in Authorization header or x-api-key header'
      });
      return;
    }

    // Validate Ethiopian phone number format
    if (!isValidEthiopianPhone(phoneNumber)) {
      res.status(400).json({
        success: false,
        error: 'Invalid Ethiopian phone number format. Must start with 251 and be 12 digits total'
      });
      return;
    }

    logger.info(`[CBEBirr Route] Processing GET verification request for receipt: ${receiptNumber}, phone: ${phoneNumber}`);

    // Call the verification service
    const result = await verifyCBEBirr(receiptNumber, phoneNumber, apiKey);

    // Return the result
    res.json(result);

  } catch (error) {
    logger.error('[CBEBirr Route] Error in GET endpoint:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

export default router;