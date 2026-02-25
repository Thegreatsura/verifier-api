import axios from 'axios';
import pdf from 'pdf-parse';
import https from 'https';
import logger from '../utils/logger';

export interface MpesaVerifyResult {
    success: boolean;
    payerName?: string;
    payerAccount?: string;
    receiverName?: string;
    receiverAccount?: string;
    transactionId?: string;
    receiptNo?: string;
    paymentDate?: Date;
    amount?: number;
    serviceFee?: number;
    vat?: number;
    error?: string;
}

function titleCase(str: string): string {
    return str.toLowerCase().replace(/\b\w/g, char => char.toUpperCase());
}

export async function verifyMpesa(
    transactionId: string
): Promise<MpesaVerifyResult> {
    const primaryUrl = `https://m-pesabusiness.safaricom.et/api/receipt/getReceipt?trxNo=${transactionId}`;
    const proxyKey = process.env.MPESA_PROXY_KEY || '';
    const fallbackUrl = `https://leul.et/mpesa.php?reference=${transactionId}&key=${proxyKey}`;
    const skipPrimary = process.env.SKIP_PRIMARY_VERIFICATION === "true";

    async function fetchFromUrl(url: string, source: string): Promise<any> {
        logger.info(`🔎 Fetching receipt data from ${source}: ${url}`);
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': 'application/json, text/plain, */*',
                'Referer': 'https://m-pesabusiness.safaricom.et/'
            },
            timeout: 60000
        });
        return response.data;
    }

    try {
        let data: any = null;

        if (!skipPrimary) {
            try {
                data = await fetchFromUrl(primaryUrl, "primary API");
            } catch (err: any) {
                logger.warn(`⚠️ Primary M-Pesa fetch failed: ${err.message}. Trying fallback proxy...`);
            }
        } else {
            logger.info(`⏭️ Skipping primary verifier due to SKIP_PRIMARY_VERIFICATION=true`);
        }

        // Try proxy if primary failed, skipped or returned a bad responseCode
        if (!data || data.responseCode !== "0" || !data.base64Data) {
            try {
                data = await fetchFromUrl(fallbackUrl, "fallback proxy");
            } catch (err: any) {
                logger.error(`❌ M-Pesa fallback proxy request failed: ${err.message}`);
            }
        }

        if (!data) {
             return {
                success: false,
                error: `Failed to fetch M-Pesa receipt from both primary and fallback sources.`
            };
        }

        logger.info(`📡 API Response Code: ${data.responseCode}, Description: ${data.responseDescription}`);

        if (data.responseCode === "0" && data.base64Data) {
            logger.info('✅ API returned success and base64 data. Converting to buffer...');

            try {
                const pdfBuffer = Buffer.from(data.base64Data, 'base64');
                logger.info(`📦 PDF Buffer created (${pdfBuffer.length} bytes). Parsing PDF...`);
                return await parseMpesaReceipt(pdfBuffer);
            } catch (err: any) {
                logger.error(`❌ Failed to convert/parse base64 PDF: ${err.message}`);
                return {
                    success: false,
                    error: `Failed to process PDF data: ${err.message}`
                };
            }
        } else {
            logger.warn(`⚠️ M-Pesa returned unsuccessful code or missing data: ${JSON.stringify(data)}`);
            return {
                success: false,
                error: `API Error: ${data.responseDescription || 'Unknown error'}`
            };
        }

    } catch (error: any) {
        logger.error(`❌ M-Pesa verification failed: ${error.message}`);
        return {
            success: false,
            error: `Request failed: ${error.message}`
        };
    }
}

async function parseMpesaReceipt(buffer: Buffer | ArrayBuffer): Promise<MpesaVerifyResult> {
    try {
        const parsed = await pdf(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
        // Remove multiple spaces but keep some structure
        const rawText = parsed.text.replace(/\s+/g, ' ').trim();

        logger.info('📄 Parsing M-Pesa receipt text');
        logger.debug(`📝 Raw PDF text length: ${rawText.length} characters`);

        // Log preview for debugging
        const textPreview = rawText.length > 1000
            ? `${rawText.substring(0, 500)}...${rawText.substring(rawText.length - 500)}`
            : rawText;
        logger.debug(`🔍 PDF text preview: ${textPreview}`);

        const payerNameMatch = rawText.match(/PAYER NAME\s+(.*?)\s+(?:PAYER PHONE|00\d+|Addis Ababa|\+251|የከፋይ ስም)/i);
        let payerName = payerNameMatch ? payerNameMatch[1].trim() : undefined;

        const payerPhoneMatch = rawText.match(/PAYER PHONE NUMBER\s+(\d+)/i);
        const payerPhone = payerPhoneMatch ? payerPhoneMatch[1].trim() : undefined;

        const txIdMatch = rawText.match(/TRANSACTION ID\s+([A-Z0-9]+)/i);
        const transactionId = txIdMatch ? txIdMatch[1].trim() : undefined;

        const receiptNoMatch = rawText.match(/RECEIPT NO.*?([A-Z0-9]{10,})(?:202\d)/i);
        const receiptNo = receiptNoMatch ? receiptNoMatch[1].trim() : undefined;

        const amountMatch = rawText.match(/TOTAL\s+([\d,]+\.\d{2})/i);
        let amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : undefined;

        const serviceFeeMatch = rawText.match(/([\d,]+\.\d{2})\s*Birr\s*\/\s*SERVICE FEE/i);
        const serviceFee = serviceFeeMatch ? parseFloat(serviceFeeMatch[1].replace(/,/g, '')) : undefined;

        const vatBetweenMatch = rawText.match(/SERVICE FEE\s*\/\s*([\d,]+\.\d{2})\s*.*?\+ 15% VAT/i);
        let vat = vatBetweenMatch ? parseFloat(vatBetweenMatch[1].replace(/,/g, '')) : undefined;

        if (vat === undefined && serviceFee !== undefined) {
            if (rawText.match(/\/ \+ 15% VAT/)) {
                vat = 0.0;
            }
        }

        const dateMatch = rawText.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
        const paymentDate = dateMatch ? new Date(dateMatch[1]) : undefined;

        const receiverNameMatch = rawText.match(/RECEIVER NAME.*?(?:የተቀባዩ ቢዝነስ ስም)?\s+([A-Za-z\s]+?)\s+\//i);
        let receiverName = receiverNameMatch ? receiverNameMatch[1].trim() : undefined;

        const receiverNumMatch = rawText.match(/RECEIVER NUMBER\s+(\d+)/i);
        let receiverPhone = receiverNumMatch ? receiverNumMatch[1].trim() : undefined;

        // Fallback for receiver phone if it appears after Total
        if (!receiverPhone) {
            const potentialPhoneAfterTotal = rawText.match(/TOTAL\s+[\d,]+\.\d{2}\s+(\d{9,12})/i);
            if (potentialPhoneAfterTotal) receiverPhone = potentialPhoneAfterTotal[1];
        }

        // Clean up Payer Name (remove extra numbers/address info if captured inadvertently)
        if (payerName) {
            // If it captures "Commercial Bank Of Ethiopia 0084..." stop at the number
            payerName = payerName.replace(/\d+.*/, '').trim();
            payerName = titleCase(payerName);
        }

        return {
            success: true,
            payerName,
            payerAccount: payerPhone,
            receiverName: receiverName ? titleCase(receiverName) : undefined,
            receiverAccount: receiverPhone,
            transactionId,
            receiptNo,
            paymentDate,
            amount,
            serviceFee,
            vat
        };

    } catch (err: any) {
        logger.error(`❌ Error parsing PDF buffer: ${err.message}`);
        return {
            success: false,
            error: `Failed to parse PDF content: ${err.message}`
        };
    }
}