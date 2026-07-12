interface SendPurchaseEmailInput {
  to: string;
  buyerName?: string | null;
  sellerName?: string | null;
  productName?: string | null;
  paymentLinkName: string;
  reference: string;
  provider: string;
  amountPaid: number;
  successMessage?: string | null;
  deliveryUrl?: string | null;
  redirectUrl?: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatProvider(provider: string): string {
  switch (provider.toLowerCase()) {
    case 'telebirr':
      return 'Telebirr';
    case 'cbebirr':
      return 'CBE Birr';
    case 'mpesa':
      return 'M-Pesa';
    case 'cbe':
      return 'CBE';
    case 'dashen':
      return 'Dashen';
    case 'abyssinia':
      return 'Abyssinia';
    default:
      return provider;
  }
}

function buildPurchaseEmailHtml(input: SendPurchaseEmailInput): string {
  const buyerName = input.buyerName?.trim() || null;
  const sellerName = input.sellerName?.trim() || 'Veritas merchant';
  const title = input.productName?.trim() || input.paymentLinkName.trim();
  const accessUrl = input.deliveryUrl?.trim() || input.redirectUrl?.trim() || null;
  const instructions = input.successMessage?.trim() || null;

  return `
    <div style="font-family:Arial,sans-serif;background:#060606;color:#f4f4f5;padding:24px">
      <div style="max-width:640px;margin:0 auto;border:1px solid rgba(255,255,255,0.08);border-radius:18px;background:rgba(255,255,255,0.03);padding:24px">
        <p style="margin:0 0 12px;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.45)">Purchase confirmation</p>
        <h1 style="margin:0 0 10px;font-size:28px;line-height:1.2;color:#ffffff">Your payment is confirmed</h1>
        ${buyerName ? `<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:rgba(255,255,255,0.72)">Hi ${escapeHtml(buyerName)},</p>` : ''}
        <p style="margin:0 0 22px;font-size:15px;line-height:1.7;color:rgba(255,255,255,0.72)">
          You successfully paid for <strong style="color:#ffffff">${escapeHtml(title)}</strong> from
          <strong style="color:#ffffff">${escapeHtml(sellerName)}</strong>.
        </p>
        <div style="border-radius:14px;background:#0b0b0b;padding:18px;border:1px solid rgba(255,255,255,0.08);margin-bottom:18px">
          <p style="margin:0 0 8px;font-size:13px;color:rgba(255,255,255,0.5)">Reference</p>
          <p style="margin:0 0 14px;font-size:18px;font-weight:700;color:#ffffff">${escapeHtml(input.reference)}</p>
          <p style="margin:0 0 8px;font-size:13px;color:rgba(255,255,255,0.5)">Amount paid</p>
          <p style="margin:0 0 14px;font-size:18px;font-weight:700;color:#ffffff">${input.amountPaid.toLocaleString()} ETB</p>
          <p style="margin:0 0 8px;font-size:13px;color:rgba(255,255,255,0.5)">Payment method</p>
          <p style="margin:0;font-size:16px;color:#ffffff">${escapeHtml(formatProvider(input.provider))}</p>
        </div>
        ${instructions ? `
          <div style="margin-bottom:18px">
            <p style="margin:0 0 10px;font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.45)">Instructions</p>
            <div style="border-radius:14px;background:#0b0b0b;padding:16px;border:1px solid rgba(255,255,255,0.08);font-size:14px;line-height:1.7;color:rgba(255,255,255,0.76);white-space:pre-wrap">${escapeHtml(instructions)}</div>
          </div>
        ` : ''}
        ${accessUrl ? `
          <div style="margin-top:6px">
            <a href="${escapeHtml(accessUrl)}" style="display:inline-block;border-radius:12px;background:linear-gradient(90deg,#34d399,#818cf8);padding:12px 18px;color:#04120d;text-decoration:none;font-size:14px;font-weight:700">
              Open your access link
            </a>
            <p style="margin:12px 0 0;font-size:13px;line-height:1.6;color:rgba(255,255,255,0.5)">
              If the button does not open, use this link:<br />
              <span style="color:rgba(255,255,255,0.76)">${escapeHtml(accessUrl)}</span>
            </p>
          </div>
        ` : `
          <p style="margin:0;font-size:13px;line-height:1.6;color:rgba(255,255,255,0.5)">
            Keep this email as your purchase record. Contact the seller if you need manual delivery help.
          </p>
        `}
      </div>
    </div>
  `;
}

function buildPurchaseEmailText(input: SendPurchaseEmailInput): string {
  const buyerName = input.buyerName?.trim() || null;
  const sellerName = input.sellerName?.trim() || 'Veritas merchant';
  const title = input.productName?.trim() || input.paymentLinkName.trim();
  const accessUrl = input.deliveryUrl?.trim() || input.redirectUrl?.trim() || null;
  const instructions = input.successMessage?.trim() || null;

  return [
    buyerName ? `Hi ${buyerName},` : null,
    `Your payment for ${title} is confirmed.`,
    `Seller: ${sellerName}`,
    `Reference: ${input.reference}`,
    `Amount paid: ${input.amountPaid.toLocaleString()} ETB`,
    `Payment method: ${formatProvider(input.provider)}`,
    instructions ? `Instructions:\n${instructions}` : null,
    accessUrl ? `Access link: ${accessUrl}` : null,
  ].filter(Boolean).join('\n\n');
}

export async function sendBuyerPurchaseEmail(input: SendPurchaseEmailInput): Promise<unknown> {
  const resendKey = process.env.RESEND_API_KEY?.trim();
  const fromEmail = process.env.VERITAS_NOTIFICATIONS_FROM_EMAIL?.trim();

  if (!resendKey || !fromEmail) {
    throw new Error('RESEND_API_KEY and VERITAS_NOTIFICATIONS_FROM_EMAIL are required for buyer purchase emails.');
  }

  const sellerName = input.sellerName?.trim() || 'Veritas merchant';
  const subjectTitle = input.productName?.trim() || input.paymentLinkName.trim();

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [input.to],
      subject: `${sellerName}: your purchase for ${subjectTitle}`,
      text: buildPurchaseEmailText(input),
      html: buildPurchaseEmailHtml(input),
    }),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Buyer purchase email failed: ${response.status} ${response.statusText} ${data ? JSON.stringify(data) : ''}`.trim());
  }

  return data;
}
