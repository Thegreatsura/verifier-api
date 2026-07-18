import puppeteer from 'puppeteer';
import axios, { AxiosResponse } from 'axios';
import pdf from 'pdf-parse';
import https from 'https';
import logger from '../utils/logger';
import { extractLegacyCbeUrlData, extractNewCbeToken } from '../utils/cbeReference';

export interface VerifyResult {
    success: boolean;
    payer?: string;
    payerAccount?: string;
    receiver?: string;
    receiverAccount?: string;
    amount?: number;
    date?: Date;
    reference?: string;
    reason?: string | null;
    error?: string;
    statusCode?: number;
}

function titleCase(str: string): string {
    return str.toLowerCase().replace(/\b\w/g, char => char.toUpperCase());
}

interface CBETransactionResponse {
    id?: string;
    debitAccountHolder?: string;
    debitAccountNo?: string;
    creditAccountHolder?: string;
    creditAccountNo?: string;
    amountCredited?: string;
    dateTimes?: string[];
    paymentDetails?: string[];
}

function parseAmount(value?: string): number | undefined {
    const parsed = value ? Number.parseFloat(value) : NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
}

function mapNewCBEReceipt(data: CBETransactionResponse): VerifyResult {
    return {
        success: true,
        payer: data.debitAccountHolder,
        payerAccount: data.debitAccountNo,
        receiver: data.creditAccountHolder,
        receiverAccount: data.creditAccountNo,
        amount: parseAmount(data.amountCredited),
        date: data.dateTimes?.[0] ? new Date(data.dateTimes[0]) : undefined,
        reference: data.id,
        reason: data.paymentDetails?.join(' ') || null
    };
}

export async function verifyCBELegacy(
    reference: string,
    accountSuffix: string
): Promise<VerifyResult> {
    const fullId = `${reference}${accountSuffix}`;
    const url = `https://apps.cbe.com.et:100/?id=${fullId}`;
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });

    try {
        logger.info(`🔎 Attempting direct fetch: ${url}`);
        const response: AxiosResponse<ArrayBuffer> = await axios.get(url, {
            httpsAgent,
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': 'application/pdf'
            },
            timeout: 30000
        });

        logger.info('✅ Direct fetch success, parsing PDF');
        return await parseCBEReceipt(response.data);
    } catch (directErr: any) {
        logger.warn('⚠️ Direct fetch failed, falling back to Puppeteer:', directErr.message);

        let browser;
        try {
            browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--ignore-certificate-errors',
                    '--disable-dev-shm-usage',
                    '--disable-gpu'
                ],
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
            });

            const page = await browser.newPage();
            let detectedPdfUrl: string | null = null;

            page.on('response', async (response) => {
                const contentType = response.headers()['content-type'];
                if (contentType?.includes('pdf')) {
                    detectedPdfUrl = response.url();
                    logger.info('🧾 PDF detected:', detectedPdfUrl);
                }
            });

            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await new Promise(res => setTimeout(res, 6000));
            await browser.close();

            if (!detectedPdfUrl) {
                return { success: false, error: 'No PDF detected via Puppeteer.' };
            }

            const pdfRes = await axios.get(detectedPdfUrl, {
                httpsAgent,
                responseType: 'arraybuffer'
            });

            return await parseCBEReceipt(pdfRes.data);
        } catch (puppetErr: any) {
            logger.error('❌ Puppeteer failed:', puppetErr.message);
            if (browser) await browser.close();
            return {
                success: false,
                error: `Both direct and Puppeteer failed: ${puppetErr.message}`
            };
        }
    }
}

export async function verifyCBENew(token: string): Promise<VerifyResult> {
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });
    const url = `https://mb.cbe.com.et/api/v1/transactions/public/transaction-detail/${token}`;
    const maxRetries = 4;
    const retryDelayMs = 1800;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            logger.info(`🔎 Attempting new CBE JSON fetch (${attempt}/${maxRetries}): ${url}`);
            const response = await axios.get<CBETransactionResponse>(url, {
                httpsAgent,
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'Origin': 'https://mbreciept.cbe.com.et',
                    'Referer': 'https://mbreciept.cbe.com.et/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                    'x-app-id': process.env.CBE_APP_ID || 'd1292e42-7400-49de-a2d3-9731caa4c819',
                    'x-app-version': process.env.CBE_APP_VERSION || '0a01980b-9859-1369-8198-59f403820000'
                },
                timeout: 15000
            });

            return mapNewCBEReceipt(response.data);
        } catch (err: any) {
            const statusCode = err.response?.status;
            const isLastAttempt = attempt === maxRetries;
            const isRetryable =
                !statusCode ||
                statusCode === 429 ||
                statusCode === 502 ||
                statusCode === 503 ||
                statusCode === 504;

            logger.warn(`⚠️ New CBE verification attempt ${attempt}/${maxRetries} failed: ${err.message}`);

            if (statusCode === 404) {
                return {
                    success: false,
                    error: 'Invalid or expired CBE receipt token.',
                    statusCode: 404
                };
            }

            if (!isRetryable || isLastAttempt) {
                return {
                    success: false,
                    error: 'CBE receipt service is temporarily unavailable. Please try again.',
                    statusCode: 502
                };
            }

            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        }
    }

    return {
        success: false,
        error: 'CBE receipt service is temporarily unavailable. Please try again.',
        statusCode: 502
    };
}

export async function verifyCBE(reference: string, accountSuffix?: string): Promise<VerifyResult> {
    const legacyLink = extractLegacyCbeUrlData(reference);
    if (legacyLink) {
        const resolvedSuffix = accountSuffix?.trim() || legacyLink.suffix;
        return verifyCBELegacy(legacyLink.reference, resolvedSuffix);
    }

    const token = extractNewCbeToken(reference);
    if (token) return verifyCBENew(token);
    if (!accountSuffix?.trim()) {
        return {
            success: false,
            error: 'Missing accountSuffix for legacy CBE verification.',
            statusCode: 400
        };
    }
    return verifyCBELegacy(reference.trim(), accountSuffix.trim());
}

async function parseCBEReceipt(buffer: ArrayBuffer): Promise<VerifyResult> {
    try {
        const parsed = await pdf(Buffer.from(buffer));
        const rawText = parsed.text.replace(/\s+/g, ' ').trim();

        let payerName = rawText.match(/Payer\s*:?\s*(.*?)\s+Account/i)?.[1]?.trim();
        let receiverName = rawText.match(/Receiver\s*:?\s*(.*?)\s+Account/i)?.[1]?.trim();
        const accountMatches = [...rawText.matchAll(/Account\s*:?\s*([A-Z0-9]?\*{4}\d{4})/gi)];
        const payerAccount = accountMatches?.[0]?.[1];
        const receiverAccount = accountMatches?.[1]?.[1];

        const reason = rawText.match(/Reason\s*\/\s*Type of service\s*:?\s*(.*?)\s+Transferred Amount/i)?.[1]?.trim();
        const amountText = rawText.match(/Transferred Amount\s*:?\s*([\d,]+\.\d{2})\s*ETB/i)?.[1];
        const referenceMatch = rawText.match(/Reference No\.?\s*\(VAT Invoice No\)\s*:?\s*([A-Z0-9]+)/i)?.[1]?.trim();
        const dateRaw = rawText.match(/Payment Date & Time\s*:?\s*([\d\/,: ]+[APM]{2})/i)?.[1]?.trim();

        const amount = amountText ? parseFloat(amountText.replace(/,/g, '')) : undefined;
        const date = dateRaw ? new Date(dateRaw) : undefined;

        payerName = payerName ? titleCase(payerName) : undefined;
        receiverName = receiverName ? titleCase(receiverName) : undefined;

        if (payerName && payerAccount && receiverName && receiverAccount && amount && date && referenceMatch) {
            return {
                success: true,
                payer: payerName,
                payerAccount,
                receiver: receiverName,
                receiverAccount,
                amount,
                date,
                reference: referenceMatch,
                reason: reason || null
            };
        } else {
            return {
                success: false,
                error: 'Could not extract all required fields from PDF.'
            };
        }
    } catch (parseErr: any) {
        logger.error('❌ PDF parsing failed:', parseErr.message);
        return { success: false, error: 'Error parsing PDF data' };
    }
}
