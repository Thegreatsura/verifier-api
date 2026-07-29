import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const MAX_CLOCK_SKEW_MS = 60_000;

export function statusSignaturePayload(
  timestamp: number,
  method: string,
  originalPath: string,
): string {
  return `${timestamp}.${method.toUpperCase()}.${originalPath}`;
}

export function signStatusRequest(
  secret: string,
  timestamp: number,
  method: string,
  originalPath: string,
): string {
  return createHmac('sha256', secret)
    .update(statusSignaturePayload(timestamp, method, originalPath))
    .digest('hex');
}

export function verifyStatusSignature(input: {
  secret: string;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  method: string;
  originalPath: string;
  now?: number;
}): boolean {
  const {
    secret,
    timestampHeader,
    signatureHeader,
    method,
    originalPath,
    now = Date.now(),
  } = input;
  if (!timestampHeader || !signatureHeader || !/^\d{13}$/.test(timestampHeader)) {
    return false;
  }
  if (!/^[a-f0-9]{64}$/.test(signatureHeader)) return false;
  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > MAX_CLOCK_SKEW_MS) {
    return false;
  }

  const expected = Buffer.from(
    signStatusRequest(secret, timestamp, method, originalPath),
    'hex',
  );
  const supplied = Buffer.from(signatureHeader, 'hex');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function statusMonitorSignature(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const secret = process.env.STATUS_MONITOR_SECRET;
  const originalPath = req.originalUrl.split('?')[0];
  const valid = Boolean(secret) && verifyStatusSignature({
    secret: secret ?? '',
    timestampHeader: req.header('x-veritas-status-timestamp'),
    signatureHeader: req.header('x-veritas-status-signature'),
    method: req.method,
    originalPath,
  });

  if (!valid) {
    res.status(401).json({ error: 'Unauthorized status monitor request.' });
    return;
  }
  next();
}
