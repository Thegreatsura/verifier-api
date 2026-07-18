/**
 * paymentMatch.ts
 *
 * Shared helpers for extracting the verified amount + credited account from
 * provider-specific verification responses, and matching the credited account
 * against a merchant's payout account. Used by /payment-links/.../confirm
 * and /admin/verify-payment (the product purchase flow).
 */

export interface PaymentDetails {
  amount: number | null;
  account: string | null; // null when provider doesn't return an account number
}

/** Normalise Ethiopian phone numbers to the 251 prefix for comparison. */
export function normalisePhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  if (d.startsWith('251')) return d;
  if (d.startsWith('09') || d.startsWith('07')) return '251' + d.slice(1);
  return d;
}

function normaliseCbeMaskToken(value: string): string {
  return value.replace(/[^A-Za-z0-9*]/g, '').toUpperCase();
}

export function maskCbeAccount(account: string): string | null {
  const normalized = account.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (normalized.length < 5) return null;
  return `${normalized[0]}***${normalized.slice(-4)}`;
}

export function cbeAccountMatches(verifiedAccount: string | null, merchantAccount: string): boolean {
  if (verifiedAccount === null) return false;

  const normalizedVerified = normaliseCbeMaskToken(verifiedAccount);
  const canonicalVerified = normalizedVerified.includes('*')
    ? `${normalizedVerified[0]}***${normalizedVerified.slice(-4)}`
    : maskCbeAccount(normalizedVerified);
  const canonicalMerchant = maskCbeAccount(merchantAccount);

  if (!canonicalVerified || !canonicalMerchant) return false;
  return canonicalVerified === canonicalMerchant;
}

/** Basic format check — Ethiopian phone or 13–16 digit bank account. */
export function isValidMerchantAccount(account: string): boolean {
  const cleaned = account.trim();
  if (/^(09|07)\d{8}$/.test(cleaned)) return true;
  if (/^251(9|7)\d{8}$/.test(cleaned)) return true;
  if (/^\d{13,16}$/.test(cleaned)) return true;
  return false;
}

/**
 * Extract the verified amount and credited account from a raw service result,
 * keyed by the provider the caller specified.
 */
export function extractPaymentDetails(data: unknown, provider: string): PaymentDetails {
  const d = data as Record<string, unknown>;

  switch (provider.toLowerCase()) {
    case 'telebirr':
      return {
        amount: d.settledAmount != null ? parseFloat(String(d.settledAmount)) : null,
        account: typeof d.creditedPartyAccountNo === 'string' ? d.creditedPartyAccountNo : null,
      };
    case 'cbe':
      return {
        amount: typeof d.amount === 'number' ? d.amount : null,
        account: typeof d.receiverAccount === 'string' ? d.receiverAccount : null,
      };
    case 'dashen':
      return {
        amount: typeof d.transactionAmount === 'number' ? d.transactionAmount : null,
        account: null, // Dashen response has only receiverName, not an account number
      };
    case 'abyssinia':
      return {
        amount: typeof d.amount === 'number' ? d.amount : null,
        account: typeof d.receiverAccount === 'string' ? d.receiverAccount : null,
      };
    case 'cbebirr':
      return {
        amount:
          d.paidAmount != null
            ? parseFloat(String(d.paidAmount))
            : d.amount != null
              ? parseFloat(String(d.amount))
              : null,
        account: typeof d.creditAccount === 'string' ? d.creditAccount : null,
      };
    default:
      return { amount: null, account: null };
  }
}

/**
 * Returns true if the verified credited account matches the merchant account.
 * Phone numbers are normalised before comparison; masked phone numbers (e.g.
 * `2519***1234`) are matched by prefix/suffix.
 * When `verifiedAccount` is null (e.g. Dashen), the check is skipped.
 */
export function accountMatches(verifiedAccount: string | null, merchantAccount: string): boolean {
  if (verifiedAccount === null) return true;

  const trimmedVerified = verifiedAccount.trim();
  const trimmedMerchant = merchantAccount.trim();

  const looksLikePhone = (s: string) => /^(09|07|251)/.test(s.replace(/\D/g, ''));
  if (looksLikePhone(trimmedVerified) && looksLikePhone(trimmedMerchant)) {
    const maskedMatch = trimmedVerified.match(/^(251\d{1})\*+(\d{4})$/);
    const normalizedMerchant = normalisePhone(trimmedMerchant);

    if (maskedMatch) {
      const visiblePrefix = maskedMatch[1] ?? '';
      const visibleSuffix = maskedMatch[2] ?? '';
      return normalizedMerchant.startsWith(visiblePrefix) && normalizedMerchant.endsWith(visibleSuffix);
    }
    return normalisePhone(trimmedVerified) === normalizedMerchant;
  }

  return trimmedVerified === trimmedMerchant;
}
