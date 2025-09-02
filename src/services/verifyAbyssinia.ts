import axios, { AxiosError } from 'axios';
import logger from '../utils/logger';
import { VerifyResult } from './verifyCBE';

export interface AbyssiniaReceipt {
    sourceAccountName: string;
    vat: string;
    transferredAmountInWord: string;
    address: string;
    transactionType: string;
    serviceCharge: string;
    sourceAccount: string;
    paymentReference: string;
    tel: string;
    payerName: string;
    narrative: string;
    transferredAmount: string;
    transactionReference: string;
    transactionDate: string;
    totalAmountIncludingVAT: string;
}

/**
 * Verify Abyssinia bank transaction by fetching JSON data from their API
 * @param reference Transaction reference (e.g., "FT23062669JJ")
 * @param suffix Last 5 digits of user's account (e.g., "90172")
 * @returns Promise<VerifyResult>
 */
export async function verifyAbyssinia(reference: string, suffix: string): Promise<VerifyResult> {
    try {
        logger.info(`🏦 Starting Abyssinia verification for reference: ${reference} with suffix: ${suffix}`);
        
        // Construct the API URL
        const apiUrl = `https://cs.bankofabyssinia.com/api/onlineSlip/getDetails/?id=${reference}${suffix}`;
        logger.info(`📡 Fetching from URL: ${apiUrl}`);
        
        // Fetch JSON data from the API
        const response = await axios.get(apiUrl, {
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            }
        });
        
        logger.info(`✅ Successfully fetched response with status: ${response.status}`);
        
        // Debug log response headers
        logger.debug(`📋 Response headers:`, JSON.stringify(response.headers, null, 2));
        
        // Debug log complete response structure
        logger.debug(`📄 Complete response data:`, JSON.stringify(response.data, null, 2));
        
        // Debug log response size and content type
        logger.debug(`📊 Response size: ${JSON.stringify(response.data).length} characters`);
        logger.debug(`📝 Content-Type: ${response.headers['content-type'] || 'unknown'}`);
        
        // Parse the JSON response
        const jsonData = response.data;
        
        // Check if the response has the expected structure
        if (!jsonData || !jsonData.header || !jsonData.body || !Array.isArray(jsonData.body)) {
            logger.error('❌ Invalid response structure from Abyssinia API');
            return { success: false, error: 'Invalid response structure from Abyssinia API' };
        }
        
        // Check if the request was successful
        if (jsonData.header.status !== 'success') {
            logger.error(`❌ API returned error status: ${jsonData.header.status}`);
            return { success: false, error: `API returned error status: ${jsonData.header.status}` };
        }
        
        // Check if there's data in the body
        if (jsonData.body.length === 0) {
            logger.error('❌ No transaction data found in response body');
            return { success: false, error: 'No transaction data found in response body' };
        }
        
        // Extract the first (and typically only) transaction record
        const transactionData = jsonData.body[0];
        logger.debug(`📋 Raw transaction data from API:`, JSON.stringify(transactionData, null, 2));
        logger.debug(`🔍 Available fields in transaction data:`, Object.keys(transactionData));
        logger.debug(`📊 Number of fields in transaction: ${Object.keys(transactionData).length}`);
        
        // Map the response fields to standardized VerifyResult structure with detailed field-by-field logging
        logger.debug(`🔄 Starting field mapping process...`);
        
        // Extract and parse the amount
        const transferredAmountStr = transactionData['Transferred Amount'] || '';
        const amount = transferredAmountStr ? parseFloat(transferredAmountStr.replace(/[^\d.]/g, '')) : undefined;
        
        // Parse the date
        const transactionDateStr = transactionData['Transaction Date'] || '';
        const date = transactionDateStr ? new Date(transactionDateStr) : undefined;
        
        const result: VerifyResult = {
            success: true,
            payer: transactionData["Payer's Name"] || undefined,
            payerAccount: transactionData['Source Account'] || undefined,
            receiver: transactionData['Source Account Name'] || undefined, // This might be the receiver in Abyssinia context
            receiverAccount: undefined, // Not available in Abyssinia data
            amount: amount,
            date: date,
            reference: transactionData['Transaction Reference'] || undefined,
            reason: transactionData['Narrative'] || null
        };
        
        // Debug log each field mapping
        logger.debug(`🏷️  Field mappings:`);
        logger.debug(`   payer: "${transactionData["Payer's Name"]}" -> "${result.payer}"`);
        logger.debug(`   payerAccount: "${transactionData['Source Account']}" -> "${result.payerAccount}"`);
        logger.debug(`   receiver: "${transactionData['Source Account Name']}" -> "${result.receiver}"`);
        logger.debug(`   amount: "${transactionData['Transferred Amount']}" -> ${result.amount}`);
        logger.debug(`   date: "${transactionData['Transaction Date']}" -> ${result.date}`);
        logger.debug(`   reference: "${transactionData['Transaction Reference']}" -> "${result.reference}"`);
        logger.debug(`   reason: "${transactionData['Narrative']}" -> "${result.reason}"`);
        
        logger.debug(`✅ Field mapping completed. Mapped ${Object.keys(result).length} fields.`);
        
        logger.debug(`📋 Final mapped result object:`, JSON.stringify(result, null, 2));
        logger.info(`✅ Successfully parsed Abyssinia receipt for reference: ${result.reference}`);
        logger.debug(`💰 Key transaction details - Amount: ${result.amount}, Payer: ${result.payer}, Date: ${result.date}`);
        
        // Validate that we have essential fields
        if (!result.reference || !result.amount || !result.payer) {
            logger.error('❌ Missing essential fields in transaction data');
            return { success: false, error: 'Missing essential fields in transaction data' };
        }
        
        return result;
        
    } catch (error) {
        if (error instanceof AxiosError) {
            logger.error(`❌ HTTP Error fetching Abyssinia receipt: ${error.message}`);
            if (error.response) {
                logger.error(`📊 Response status: ${error.response.status}`);
                logger.error(`📄 Response data:`, error.response.data);
            }
        } else {
            logger.error(`❌ Unexpected error in verifyAbyssinia:`, error);
        }
        return { success: false, error: 'Failed to verify Abyssinia transaction' };
    }
}