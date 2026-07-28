import { Request } from 'express';

export const BILLING_PAYMENT_OPERATION = 'billing-payment';
export const INTERNAL_OPERATION_HEADER = 'x-veritas-internal-operation';

type TrustedInternalOperation = typeof BILLING_PAYMENT_OPERATION;

export function markTrustedInternalOperation(
  req: Request,
  operation: TrustedInternalOperation,
): void {
  (req as any).trustedInternalOperation = operation;
}

export function isTrustedBillingPaymentVerification(req: Request): boolean {
  return (req as any).trustedInternalOperation === BILLING_PAYMENT_OPERATION;
}
