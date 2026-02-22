import axios from 'axios';
import pdfParse from 'pdf-parse';
import { VerifyResult } from './verifyCBE';
import logger from '../utils/logger';

export interface CBEBirrReceipt {
  customerName: string;
  debitAccount: string;
  creditAccount: string;
  receiverName: string;
  orderId: string;
  transactionStatus: string;
  reference: string;
  receiptNumber: string;
  transactionDate: string;
  amount: string;
  paidAmount: string;
  serviceCharge: string;
  vat: string;
  totalPaidAmount: string;
  paymentReason: string;
  paymentChannel: string;
}

export async function verifyCBEBirr(
  receiptNumber: string,
  phoneNumber: string,
  apiKey: string
): Promise<CBEBirrReceipt | { success: false; error: string }> {
  try {
    logger.info(`[CBEBirr] Starting verification for receipt: ${receiptNumber}, phone: ${phoneNumber}`);

    // Construct the CBE Birr URL
    const url = `https://cbepay1.cbe.com.et/aureceipt?TID=${receiptNumber}&PH=${phoneNumber}`;
    logger.info(`[CBEBirr] Fetching PDF from: ${url}`);

    // Fetch the PDF
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 30000
    });

    logger.info(`[CBEBirr] PDF response status: ${response.status}`);
    logger.info(`[CBEBirr] PDF content length: ${response.data.length} bytes`);

    if (response.status !== 200) {
      logger.error(`[CBEBirr] Failed to fetch PDF: HTTP ${response.status}`);
      return { success: false, error: `Failed to fetch receipt: HTTP ${response.status}` };
    }

    // Parse the PDF
    const pdfBuffer = Buffer.from(response.data);
    const pdfData = await pdfParse(pdfBuffer);
    const pdfText = pdfData.text;

    logger.info(`[CBEBirr] PDF text extracted (${pdfText.length} characters)`);
    logger.info('[CBEBirr] PDF content preview:', pdfText.substring(0, 1000));
    logger.info('[CBEBirr] Full PDF text content:');
    logger.info(pdfText);

    // Parse the receipt data
    const receiptData = parseCBEBirrReceipt(pdfText);

    if (!receiptData) {
      logger.error('[CBEBirr] Failed to parse receipt data from PDF');
      return { success: false, error: 'Failed to parse receipt data from PDF' };
    }

    logger.info('[CBEBirr] Successfully parsed receipt data:', receiptData);
    return receiptData;

  } catch (error) {
    logger.error('[CBEBirr] Error during verification:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

function parseCBEBirrReceipt(pdfText: string): CBEBirrReceipt | null {
  try {
    logger.info('[CBEBirr] Starting PDF text parsing...');
    logger.info('[CBEBirr] Full PDF text for debugging:', pdfText);

    const extractValue = (text: string, pattern: RegExp): string => {
      const match = text.match(pattern);
      const result = match && match[1] ? match[1].trim() : '';
      // Optional: Clean up messy newlines inside the captured result
      return result.replace(/\n/g, ' ').replace(/\s{2,}/g, ' ');
    };

    // 1. Customer Name (Trapped between 'Sub city:' and 'Wereda/kebele:')
    const customerName = extractValue(pdfText, /Sub city:[\s\n]+([A-Z\s]+?)[\s\n]+Wereda\/kebele:/i);

    // 2. Account Details (Using [\s\S]*? to safely capture across newlines before the next label)
    const debitAccountMatch = pdfText.match(/Debit Account\s*(Org Account|[\s\S]*?)(?=\s*Credit Account)/i);
    const debitAccount = debitAccountMatch ? debitAccountMatch[1].replace(/\n/g, ' ').trim() : '';
    const creditAccount = extractValue(pdfText, /Credit Account\s*([\s\S]*?)(?=\s*Receiver Name)/i);
    const receiverName = extractValue(pdfText, /Receiver Name\s*([\s\S]*?)(?=\s*Order ID)/i);

    // 3. Status and IDs
    const orderId = extractValue(pdfText, /Order ID\s*([A-Z0-9]+)/i);
    const transactionStatus = extractValue(pdfText, /Transaction Status\s*([a-zA-Z]+)/i);

    // Reference (Captures ANY text after "Reference" until the next known section header)
    const refMatch = pdfText.match(/Reference[\s:]*([\s\S]*?)(?=\s*(?:Transaction Details|Receipt Number|የኢትዮጵያ|Commercial Bank))/i);
    let reference = refMatch ? refMatch[1].replace(/\n/g, ' ').trim() : '';

    // Aggressively strip any leading or trailing spaces and colons caused by the PDF parser
    reference = reference.replace(/^[\s:]+|[\s:]+$/g, '');

    // 4. Receipt Data
    const receiptDataMatch = pdfText.match(/([A-Z0-9]{10})(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})([\d.]+)/);
    const receiptNumber = receiptDataMatch ? receiptDataMatch[1] : '';
    const transactionDate = receiptDataMatch ? receiptDataMatch[2] : '';
    const amount = receiptDataMatch ? receiptDataMatch[3] : '';

    // 5. Financial Details Block (Values are dumped *before* the labels)
    const financialMatch = pdfText.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+Paid amount/i);
    const paidAmount = financialMatch ? financialMatch[1] : '';
    const serviceCharge = financialMatch ? financialMatch[2] : '';
    const vat = financialMatch ? financialMatch[3] : '';
    const totalPaidAmount = financialMatch ? financialMatch[4] : '';

    // 6. Payment Details Block (Labels are dumped *before* the values)
    // Matches: Payment Channel \n Seventy... \n Transfer... \n USSD
    const paymentMatch = pdfText.match(/Payment Channel[\s\n]+([^\n]+)[\s\n]+([^\n]+)[\s\n]+([^\n]+)/i);
    const paymentReason = paymentMatch ? paymentMatch[2].trim() : '';
    const paymentChannel = paymentMatch ? paymentMatch[3].trim() : '';

    const receiptData: CBEBirrReceipt = {
      customerName,
      debitAccount,
      creditAccount,
      receiverName,
      orderId,
      transactionStatus,
      reference,
      receiptNumber,
      transactionDate,
      amount,
      paidAmount,
      serviceCharge,
      vat,
      totalPaidAmount,
      paymentReason,
      paymentChannel
    };

    logger.info('[CBEBirr] Extracted receipt data:', receiptData);

    // Validate that we have at least some essential fields
    if (!customerName && !receiptNumber && !amount) {
      logger.warn('[CBEBirr] No essential fields found in PDF');
      return null;
    }

    return receiptData;

  } catch (error) {
    logger.error('[CBEBirr] Error parsing PDF text:', error);
    return null;
  }
}