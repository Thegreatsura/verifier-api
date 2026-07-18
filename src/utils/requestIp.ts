import { Request } from 'express';

function firstForwardedValue(value: string | undefined): string | null {
  if (!value) return null;
  const first = value.split(',')[0]?.trim();
  return first && first.length > 0 ? first : null;
}

export function getRequestIp(req: Request): string {
  const forwardedFor = firstForwardedValue(req.headers['x-forwarded-for'] as string | undefined);
  if (forwardedFor) return forwardedFor;

  const realIp = (req.headers['x-real-ip'] as string | undefined)?.trim();
  if (realIp) return realIp;

  return req.ip || 'unknown';
}
