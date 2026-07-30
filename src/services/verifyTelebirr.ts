import axios, { AxiosError } from "axios";
import * as cheerio from "cheerio";
import logger from '../utils/logger';
import type {
    TelebirrProbeDetails,
    TelebirrRouteStatus
} from '../types/statusProbe';

export interface TelebirrReceipt {
    payerName: string;
    payerTelebirrNo: string;
    creditedPartyName: string;
    creditedPartyAccountNo: string;
    transactionStatus: string;
    receiptNo: string;
    paymentDate: string;
    settledAmount: string;
    serviceFee: string;
    serviceFeeVAT: string;
    totalPaidAmount: string;
    bankName: string;
    customerNote: string;
}

/**
 * Enhanced regex-based extractor for settled amount - multiple patterns like PHP version
 * @param htmlContent The raw HTML content
 * @returns Extracted settled amount or null
 */
function extractSettledAmountRegex(htmlContent: string): string | null {
    // Pattern 1: Direct match with the exact text structure
    const pattern1 = /የተከፈለው\s+መጠን\/Settled\s+Amount.*?<\/td>\s*<td[^>]*>\s*([\d,]+(?:\.\d+)?\s+Birr)/is;
    let match = htmlContent.match(pattern1);
    if (match) return match[1].trim();

    // Pattern 2: Look for the table row structure
    const pattern2 = /<tr[^>]*>.*?የተከፈለው\s+መጠን\/Settled\s+Amount.*?<td[^>]*>\s*([\d,]+(?:\.\d+)?\s+Birr)/is;
    match = htmlContent.match(pattern2);
    if (match) return match[1].trim();

    // Pattern 3: More flexible approach - look for any cell containing "Settled Amount" followed by amount
    const pattern3 = /Settled\s+Amount.*?([\d,]+(?:\.\d+)?\s+Birr)/is;
    match = htmlContent.match(pattern3);
    if (match) return match[1].trim();

    // Pattern 4: Look specifically in the transaction details table
    const pattern4 = /የክፍያ\s+ዝርዝር\/Transaction\s+details.*?<tr[^>]*>.*?<td[^>]*>\s*[^<]*<\/td>\s*<td[^>]*>\s*[^<]*<\/td>\s*<td[^>]*>\s*([\d,]+(?:\.\d+)?\s+Birr)/is;
    match = htmlContent.match(pattern4);
    if (match) return match[1].trim();

    return null;
}

/**
 * Enhanced regex-based extractor for service fee
 * @param htmlContent The raw HTML content
 * @returns Extracted service fee or null
 */
function extractServiceFeeRegex(htmlContent: string): string | null {
    // Pattern to match "የአገልግሎት ክፍያ/Service fee" followed by amount in Birr
    // Make sure we don't match VAT version
    const pattern = /የአገልግሎት\s+ክፍያ\/Service\s+fee(?!\s+ተ\.እ\.ታ).*?<\/td>\s*<td[^>]*>\s*([\d,]+(?:\.\d+)?\s+Birr)/i;
    const match = htmlContent.match(pattern);
    if (match) return match[1].trim();

    return null;
}

/**
 * Enhanced regex-based extractor for receipt number
 * @param htmlContent The raw HTML content
 * @returns Extracted receipt number or null
 */
function extractReceiptNoRegex(htmlContent: string): string | null {
    // Extract receipt number from the transaction details table
    const pattern = /<td[^>]*class="[^"]*receipttableTd[^"]*receipttableTd2[^"]*"[^>]*>\s*([A-Z0-9]+)\s*<\/td>/i;
    const match = htmlContent.match(pattern);
    if (match) return match[1].trim();

    return null;
}

/**
 * Enhanced regex-based extractor for payment date
 * @param htmlContent The raw HTML content
 * @returns Extracted payment date or null
 */
function extractDateRegex(htmlContent: string): string | null {
    // Extract date in format DD-MM-YYYY HH:MM:SS
    const pattern = /(\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2})/;
    const match = htmlContent.match(pattern);
    if (match) return match[1].trim();

    return null;
}

/**
 * Generic regex extractor for other fields
 * @param htmlContent The raw HTML content
 * @param labelPattern The label to search for
 * @param valuePattern The pattern for the value (defaults to capturing any non-tag content)
 * @returns Extracted value or null
 */
function extractWithRegex(htmlContent: string, labelPattern: string, valuePattern: string = '([^<]+)'): string | null {
    // Escape special regex characters in the label pattern
    const escapedLabel = labelPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escapedLabel}.*?<\\/td>\\s*<td[^>]*>\\s*${valuePattern}`, 'i');
    const match = htmlContent.match(pattern);
    if (match) return match[1].replace(/<[^>]*>/g, '').trim(); // Strip any remaining HTML tags

    return null;
}

/**
 * Regex-based extractor for settled amount and service fee as fallback
 * @param htmlContent The raw HTML content
 * @returns Object containing extracted values
 */
function extractWithRegexLegacy(htmlContent: string): { settledAmount: string | null; serviceFee: string | null } {
    // Use the new enhanced extractors
    const settledAmount = extractSettledAmountRegex(htmlContent);
    const serviceFee = extractServiceFeeRegex(htmlContent);

    return {
        settledAmount,
        serviceFee
    };
}

/**
 * Scrapes Telebirr receipt data from HTML content
 * @param html The HTML content to scrape
 * @returns Extracted Telebirr receipt data
 */
function scrapeTelebirrReceipt(html: string): TelebirrReceipt {
    const $ = cheerio.load(html);

    // Log HTML content in debug mode to help diagnose scraping issues
    logger.debug(`HTML content length: ${html.length} bytes`);
    if (html.length < 100) {
        logger.warn(`Suspiciously short HTML response: ${html}`);
    }

    const getText = (selector: string): string =>
        $(selector).next().text().trim();

    const getPaymentDate = (): string => {
        // First try regex extraction
        const regexDate = extractDateRegex(html);
        if (regexDate) return regexDate;

        // Fallback to cheerio
        return $('.receipttableTd').filter((_, el) => $(el).text().includes("-202")).first().text().trim();
    };

    const getReceiptNo = (): string => {
        // First try regex extraction
        const regexReceiptNo = extractReceiptNoRegex(html);
        if (regexReceiptNo) return regexReceiptNo;

        // Fallback to cheerio
        return $('td.receipttableTd.receipttableTd2')
            .eq(1) // second match: the value, not the label
            .text()
            .trim();
    };

    const getSettledAmount = (): string => {
        // First try the enhanced regex approach
        const regexAmount = extractSettledAmountRegex(html);
        if (regexAmount) return regexAmount;

        // Fallback to cheerio approach
        let amount = $('td.receipttableTd.receipttableTd2')
            .filter((_, el) => {
                const prevTd = $(el).prev();
                return prevTd.text().includes("የተከፈለው መጠን") || prevTd.text().includes("Settled Amount");
            })
            .text()
            .trim();

        // If that doesn't work, try looking in the transaction details table
        if (!amount) {
            amount = $('tr')
                .filter((_, el) => {
                    return $(el).find('td').first().text().includes("የተከፈለው መጠን") ||
                        $(el).find('td').first().text().includes("Settled Amount");
                })
                .find('td')
                .last()
                .text()
                .trim();
        }

        return amount;
    };

    const getServiceFee = (): string => {
        // First try the enhanced regex approach
        const regexFee = extractServiceFeeRegex(html);
        if (regexFee) return regexFee;

        // Fallback to cheerio approach - look for service fee but not service fee VAT
        let fee = $('td.receipttableTd1')
            .filter((_, el) => {
                const text = $(el).text();
                return (text.includes("የአገልግሎት ክፍያ") || text.includes("Service fee")) &&
                    !text.includes("ተ.እ.ታ") && !text.includes("VAT");
            })
            .next('td.receipttableTd.receipttableTd2')
            .text()
            .trim();

        // Alternative approach - look in table rows
        if (!fee) {
            fee = $('tr')
                .filter((_, el) => {
                    const text = $(el).text();
                    return (text.includes("የአገልግሎት ክፍያ") || text.includes("Service fee")) &&
                        !text.includes("ተ.እ.ታ") && !text.includes("VAT");
                })
                .find('td')
                .last()
                .text()
                .trim();
        }

        return fee;
    };

    // Helper function to extract text using regex first, then cheerio
    const getTextWithFallback = (labelText: string, cheerioSelector?: string): string => {
        // Try regex first
        const regexResult = extractWithRegex(html, labelText);
        if (regexResult) return regexResult;

        // Fallback to cheerio if selector provided
        if (cheerioSelector) {
            return getText(cheerioSelector);
        }

        // Default cheerio approach
        return getText(`td:contains("${labelText}")`);
    };

    logger.debug("SERVICE FEE: ", getServiceFee());
    logger.debug("SETTLED AMOUNT: ", getSettledAmount());

    // Get regex results as backup for debugging
    const regexResults = extractWithRegexLegacy(html);
    logger.debug("Regex results:", regexResults);

    let creditedPartyName = getTextWithFallback("የገንዘብ ተቀባይ ስም/Credited Party name");
    let creditedPartyAccountNo = getTextWithFallback("የገንዘብ ተቀባይ ቴሌብር ቁ./Credited party account no");
    let bankName = "";

    const bankAccountNumberRaw = getTextWithFallback("የባንክ አካውንት ቁጥር/Bank account number");

    if (bankAccountNumberRaw) {
        bankName = creditedPartyName; // The original credited party name is the bank
        const bankAccountRegex = /(\d+)\s+(.*)/;
        const match = bankAccountNumberRaw.match(bankAccountRegex);
        if (match) {
            creditedPartyAccountNo = match[1].trim();
            creditedPartyName = match[2].trim();
        }
    }


    return {
        payerName: getTextWithFallback("የከፋይ ስም/Payer Name"),
        payerTelebirrNo: getTextWithFallback("የከፋይ ቴሌብር ቁ./Payer telebirr no."),
        creditedPartyName,
        creditedPartyAccountNo,
        transactionStatus: getTextWithFallback("የክፍያው ሁኔታ/transaction status"),
        receiptNo: getReceiptNo(),
        paymentDate: getPaymentDate(),
        settledAmount: getSettledAmount(),
        serviceFee: getServiceFee(),
        serviceFeeVAT: getTextWithFallback("የአገልግሎት ክፍያ ተ.እ.ታ/Service fee VAT"),
        totalPaidAmount: getTextWithFallback("ጠቅላላ የተከፈለ/Total Paid Amount"),
        bankName,
        customerNote: getTextWithFallback("የደንበኛ መልዕክት/Customer Note")
    };
}

/**
 * Parses Telebirr receipt data from JSON response
 * @param jsonData The JSON data from the proxy endpoint
 * @returns Extracted Telebirr receipt data
 */
function parseTelebirrJson(jsonData: any): TelebirrReceipt | null {
    try {
        // Check if the response has the expected structure
        if (!jsonData || !jsonData.success || !jsonData.data) {
            logger.warn("Invalid JSON structure from proxy endpoint.");
            return null;
        }

        const data = jsonData.data;

        return {
            payerName: data.payerName || "",
            payerTelebirrNo: data.payerTelebirrNo || "",
            creditedPartyName: data.creditedPartyName || "",
            creditedPartyAccountNo: data.creditedPartyAccountNo || "",
            transactionStatus: data.transactionStatus || "",
            receiptNo: data.receiptNo || "",
            paymentDate: data.paymentDate || "",
            settledAmount: data.settledAmount || "",
            serviceFee: data.serviceFee || "",
            serviceFeeVAT: data.serviceFeeVAT || "",
            totalPaidAmount: data.totalPaidAmount || "",
            bankName: data.bankName || "",
            customerNote: data.customerNote || ""
        };
    } catch (error) {
        logger.error("Error parsing JSON from proxy endpoint.", {
            error: error instanceof Error ? error.message : 'Unknown parse error'
        });
        return null;
    }
}

/**
 * Fetches and processes Telebirr receipt data from the primary source (HTML)
 * @param reference The Telebirr reference number
 * @param baseUrl The base URL to fetch the receipt from
 * @returns The scraped receipt data or null if failed
 */
async function fetchFromPrimarySource(reference: string, baseUrl: string): Promise<TelebirrReceipt | null> {
    const url = `${baseUrl}${reference}`;

    try {
        logger.info('Attempting to fetch Telebirr receipt from primary source.');
        const response = await axios.get(url, { timeout: 30000 }); // 30 second timeout to be safe
        logger.debug(`Received response with status: ${response.status}`);

        const extractedData = scrapeTelebirrReceipt(response.data);

        logger.info('Successfully extracted Telebirr data from primary source.', {
            transactionStatus: extractedData.transactionStatus
        });

        return extractedData;
    } catch (error) {
        // Enhanced error logging with request details
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        const errorStack = error instanceof Error ? error.stack : undefined;

        // Check if it's an Axios error to safely access response properties
        const axiosError = error as AxiosError;
        const responseDetails = axiosError.response ? {
            status: axiosError.response.status,
            statusText: axiosError.response.statusText
        } : {};

        logger.error('Error fetching Telebirr receipt from primary source.', {
            error: errorMessage,
            stack: errorStack,
            ...responseDetails
        });

        return null;
    }
}

export class TelebirrVerificationError extends Error {
    public details?: string;
    public kind: 'transport' | 'domain' | 'cancelled';

    constructor(
        message: string,
        details?: string,
        kind: 'transport' | 'domain' | 'cancelled' = 'domain'
    ) {
        super(message);
        this.name = 'TelebirrVerificationError';
        this.details = details;
        this.kind = kind;
    }
}

/**
 * Fetches and processes Telebirr receipt data from the fallback proxy (JSON)
 * @param reference The Telebirr reference number
 * @param proxyUrl The proxy URL to fetch the receipt from
 * @returns The parsed receipt data or null if failed
 */
interface ProxyFetchOptions {
    proxyKey?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    relayLabel?: string;
}

async function fetchFromProxySource(
    reference: string,
    proxyUrl: string,
    options: ProxyFetchOptions = {}
): Promise<TelebirrReceipt | null> {
    const proxyKey = options.proxyKey ?? process.env.TELEBIRR_PROXY_KEY ?? '';
    const url = `${proxyUrl}${reference}${proxyKey ? `&key=${proxyKey}` : ''}`;
    const relayLabel = options.relayLabel ?? 'configured relay';

    try {
        logger.info('Attempting Telebirr verification through relay.', {
            relay: relayLabel
        });
        const response = await axios.get(url, {
            timeout: options.timeoutMs ?? 30000,
            signal: options.signal,
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'VerifierAPI/1.0'
            }
        });

        logger.debug(`Received proxy response with status: ${response.status}`);

        // Check if response is JSON
        let data = response.data;
        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
            } catch (e) {
                logger.warn("Proxy response is not valid JSON, attempting to scrape as HTML");
                return scrapeTelebirrReceipt(response.data);
            }
        }

        if (data && data.success === false && data.error) {
            logger.info('Telebirr relay returned a domain response.', {
                relay: relayLabel
            });
            throw new TelebirrVerificationError(
                data.error,
                data.details,
                'domain'
            );
        }

        const extractedData = parseTelebirrJson(data);
        if (!extractedData) {
            logger.warn("Failed to parse JSON from proxy, attempting to scrape as HTML");
            return scrapeTelebirrReceipt(response.data);
        }

        logger.info('Successfully extracted Telebirr data from relay.', {
            relay: relayLabel,
            transactionStatus: extractedData.transactionStatus
        });

        return extractedData;
    } catch (error) {
        if (error instanceof Error && error.name === 'TelebirrVerificationError') {
            throw error;
        }

        const axiosError = error as AxiosError;
        if (axios.isCancel(error) || axiosError.code === 'ERR_CANCELED') {
            throw new TelebirrVerificationError(
                'The relay request was cancelled.',
                undefined,
                'cancelled'
            );
        }

        const isTransportFailure =
            !axiosError.response ||
            (axiosError.response.status ?? 0) >= 500 ||
            axiosError.code === 'ETIMEDOUT' ||
            axiosError.code === 'ECONNABORTED' ||
            axiosError.code === 'ECONNREFUSED';

        if (isTransportFailure) {
            logger.warn('Telebirr relay is unreachable or timed out.', {
                relay: relayLabel,
                code: axiosError.code,
                status: axiosError.response?.status
            });
            throw new TelebirrVerificationError(
                'The fallback relay is unreachable or timed out.',
                axiosError.message,
                'transport'
            );
        }

        logger.info('Telebirr relay rejected the receipt request.', {
            relay: relayLabel,
            status: axiosError.response?.status
        });

        return null;
    }
}

interface TelebirrProxyDescriptor {
    id: string;
    label: string;
    role: TelebirrRouteStatus['role'];
    url: string;
}

function positiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safePublicLabel(value: string | undefined): string | null {
    const normalized = value?.trim().replace(/\s+/g, ' ');
    if (!normalized || !/^[A-Za-z0-9 ._-]{1,32}$/.test(normalized)) return null;
    return normalized;
}

function defaultProxyLabel(url: string, index: number): string {
    if (index === 0) {
        try {
            const hostname = new URL(url).hostname.toLowerCase();
            if (hostname === 'leul.et' || hostname.endsWith('.leul.et')) {
                return 'leul.et';
            }
        } catch {
            // Invalid URLs are reported as unavailable without exposing their value.
        }
        return 'Preferred relay';
    }
    return `Community relay ${index}`;
}

export function getTelebirrProxyDescriptors(
    env: NodeJS.ProcessEnv = process.env
): TelebirrProxyDescriptor[] {
    const urls = (env.FALLBACK_PROXIES ?? '')
        .split(',')
        .map(url => url.trim())
        .filter(Boolean);
    const labels = (env.TELEBIRR_PROXY_LABELS ?? '')
        .split(',')
        .map(label => safePublicLabel(label));

    return urls.map((url, index) => ({
        id: index === 0 ? 'preferred' : `relay-${index}`,
        label: labels[index] ?? defaultProxyLabel(url, index),
        role: index === 0 ? 'preferred' : 'fallback',
        url
    }));
}

interface TelebirrProxyRuntimeState {
    consecutiveFailures: number;
    circuitOpenUntil: number;
    lastSuccessAt: number;
    averageLatencyMs: number | null;
}

interface TelebirrProxyAttemptResult {
    kind: 'attempt';
    token: number;
    descriptor: TelebirrProxyDescriptor;
    receipt: TelebirrReceipt | null;
    failureKind: TelebirrVerificationError['kind'] | null;
    error: TelebirrVerificationError | null;
    latencyMs: number;
}

interface TelebirrProxyInFlight {
    token: number;
    descriptor: TelebirrProxyDescriptor;
    controller: AbortController;
    promise: Promise<TelebirrProxyAttemptResult>;
}

type TelebirrProxyPoolEvent =
    | TelebirrProxyAttemptResult
    | { kind: 'hedge' }
    | { kind: 'deadline' };

const telebirrProxyRuntime = new Map<string, TelebirrProxyRuntimeState>();
let activeTelebirrProxyUrl: string | null = null;

function proxyRuntimeState(url: string): TelebirrProxyRuntimeState {
    const current = telebirrProxyRuntime.get(url);
    if (current) return current;

    const initial: TelebirrProxyRuntimeState = {
        consecutiveFailures: 0,
        circuitOpenUntil: 0,
        lastSuccessAt: 0,
        averageLatencyMs: null
    };
    telebirrProxyRuntime.set(url, initial);
    return initial;
}

function recordProxySuccess(
    descriptor: TelebirrProxyDescriptor,
    latencyMs: number,
    makeActive: boolean
): void {
    const state = proxyRuntimeState(descriptor.url);
    state.consecutiveFailures = 0;
    state.circuitOpenUntil = 0;
    state.lastSuccessAt = Date.now();
    state.averageLatencyMs =
        state.averageLatencyMs === null
            ? latencyMs
            : Math.round((state.averageLatencyMs * 0.7) + (latencyMs * 0.3));

    if (makeActive) {
        activeTelebirrProxyUrl = descriptor.url;
    }
}

function recordProxyTransportFailure(
    descriptor: TelebirrProxyDescriptor,
    cooldownMs: number,
    failureThreshold: number
): void {
    const state = proxyRuntimeState(descriptor.url);
    state.consecutiveFailures += 1;
    state.circuitOpenUntil =
        state.consecutiveFailures >= failureThreshold
            ? Date.now() + cooldownMs
            : 0;

    if (
        state.circuitOpenUntil > Date.now() &&
        activeTelebirrProxyUrl === descriptor.url
    ) {
        activeTelebirrProxyUrl = null;
    }
}

function orderedAvailableProxies(
    descriptors: TelebirrProxyDescriptor[],
    now: number
): TelebirrProxyDescriptor[] {
    const originalOrder = new Map(
        descriptors.map((descriptor, index) => [descriptor.url, index])
    );

    const ordered = [...descriptors]
        .sort((left, right) => {
            const leftIsActive = left.url === activeTelebirrProxyUrl;
            const rightIsActive = right.url === activeTelebirrProxyUrl;
            if (leftIsActive !== rightIsActive) return leftIsActive ? -1 : 1;

            if (left.role !== right.role) {
                return left.role === 'preferred' ? -1 : 1;
            }

            const leftState = proxyRuntimeState(left.url);
            const rightState = proxyRuntimeState(right.url);
            if (leftState.lastSuccessAt !== rightState.lastSuccessAt) {
                return rightState.lastSuccessAt - leftState.lastSuccessAt;
            }

            const leftLatency = leftState.averageLatencyMs ?? Number.MAX_SAFE_INTEGER;
            const rightLatency = rightState.averageLatencyMs ?? Number.MAX_SAFE_INTEGER;
            if (leftLatency !== rightLatency) return leftLatency - rightLatency;

            return (
                (originalOrder.get(left.url) ?? Number.MAX_SAFE_INTEGER) -
                (originalOrder.get(right.url) ?? Number.MAX_SAFE_INTEGER)
            );
        });

    const available = ordered.filter(
        descriptor => proxyRuntimeState(descriptor.url).circuitOpenUntil <= now
    );
    if (available.length > 0) return available;

    // Never let stale circuit state make a healthy tunnel permanently
    // unreachable. If every route is cooling down, allow one half-open
    // recovery attempt using the route whose cooldown expires first.
    return ordered
        .sort(
            (left, right) =>
                proxyRuntimeState(left.url).circuitOpenUntil -
                proxyRuntimeState(right.url).circuitOpenUntil
        )
        .slice(0, 1);
}

async function verifyWithTelebirrProxyPool(
    reference: string,
    descriptors: TelebirrProxyDescriptor[],
    env: NodeJS.ProcessEnv
): Promise<TelebirrReceipt | null> {
    const proxyTimeoutMs = positiveInteger(
        env.TELEBIRR_PROXY_TIMEOUT_MS,
        18_000
    );
    const hedgeDelayMs = positiveInteger(
        env.TELEBIRR_HEDGE_DELAY_MS,
        1_000
    );
    const cooldownMs = positiveInteger(
        env.TELEBIRR_PROXY_COOLDOWN_MS,
        60_000
    );
    const totalTimeoutMs = positiveInteger(
        env.TELEBIRR_TOTAL_TIMEOUT_MS,
        20_000
    );
    const failureThreshold = positiveInteger(
        env.TELEBIRR_PROXY_FAILURE_THRESHOLD,
        2
    );
    const maxParallel = Math.min(
        Math.max(1, positiveInteger(env.TELEBIRR_MAX_PARALLEL_PROXIES, 2)),
        4
    );
    const proxyKey = env.TELEBIRR_PROXY_KEY ?? '';
    const deadlineAt = Date.now() + totalTimeoutMs;
    const candidates = orderedAvailableProxies(descriptors, Date.now());

    let nextCandidateIndex = 0;
    let nextToken = 0;
    const inFlight: TelebirrProxyInFlight[] = [];
    let lastTransportError: TelebirrVerificationError | null = null;
    let sawDomainFailure = false;
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadlinePromise = new Promise<TelebirrProxyPoolEvent>(resolve => {
        deadlineTimer = setTimeout(
            () => resolve({ kind: 'deadline' }),
            totalTimeoutMs
        );
    });

    const startNextCandidate = (): boolean => {
        if (
            nextCandidateIndex >= candidates.length ||
            inFlight.length >= maxParallel
        ) {
            return false;
        }

        const descriptor = candidates[nextCandidateIndex++];
        const token = nextToken++;
        const controller = new AbortController();
        const timeoutMs = Math.max(
            1,
            Math.min(proxyTimeoutMs, deadlineAt - Date.now())
        );
        const startedAt = performance.now();
        const promise = (async (): Promise<TelebirrProxyAttemptResult> => {
            try {
                const receipt = await fetchFromProxySource(
                    reference,
                    descriptor.url,
                    {
                        proxyKey,
                        timeoutMs,
                        signal: controller.signal,
                        relayLabel: descriptor.label
                    }
                );
                return {
                    kind: 'attempt',
                    token,
                    descriptor,
                    receipt:
                        receipt && isValidReceipt(receipt)
                            ? receipt
                            : null,
                    failureKind: null,
                    error: null,
                    latencyMs: Math.round(performance.now() - startedAt)
                };
            } catch (error) {
                const verificationError =
                    error instanceof TelebirrVerificationError
                        ? error
                        : new TelebirrVerificationError(
                            'The fallback relay is unreachable or timed out.',
                            error instanceof Error ? error.message : undefined,
                            'transport'
                        );
                return {
                    kind: 'attempt',
                    token,
                    descriptor,
                    receipt: null,
                    failureKind: verificationError.kind,
                    error: verificationError,
                    latencyMs: Math.round(performance.now() - startedAt)
                };
            }
        })();

        inFlight.push({ token, descriptor, controller, promise });
        return true;
    };

    startNextCandidate();

    try {
        while (inFlight.length > 0) {
            const race: Promise<TelebirrProxyPoolEvent>[] = [
                ...inFlight.map(attempt => attempt.promise),
                deadlinePromise
            ];
            let hedgeTimer: NodeJS.Timeout | undefined;

            if (
                nextCandidateIndex < candidates.length &&
                inFlight.length < maxParallel
            ) {
                race.push(
                    new Promise<TelebirrProxyPoolEvent>(resolve => {
                        hedgeTimer = setTimeout(
                            () => resolve({ kind: 'hedge' }),
                            Math.min(
                                hedgeDelayMs,
                                Math.max(1, deadlineAt - Date.now())
                            )
                        );
                    })
                );
            }

            const event = await Promise.race(race);
            if (hedgeTimer) clearTimeout(hedgeTimer);

            if (event.kind === 'deadline') {
                for (const attempt of inFlight) {
                    recordProxyTransportFailure(
                        attempt.descriptor,
                        cooldownMs,
                        failureThreshold
                    );
                    attempt.controller.abort();
                }
                logger.warn('Telebirr relay pool reached its total deadline.');
                throw new TelebirrVerificationError(
                    'Telebirr relays did not respond before the verification deadline.',
                    undefined,
                    'transport'
                );
            }

            if (event.kind === 'hedge') {
                startNextCandidate();
                continue;
            }

            const completedIndex = inFlight.findIndex(
                attempt => attempt.token === event.token
            );
            if (completedIndex >= 0) {
                inFlight.splice(completedIndex, 1);
            }

            if (event.receipt) {
                recordProxySuccess(
                    event.descriptor,
                    event.latencyMs,
                    true
                );
                for (const attempt of inFlight) {
                    attempt.controller.abort();
                }
                return event.receipt;
            }

            if (event.failureKind === 'transport') {
                recordProxyTransportFailure(
                    event.descriptor,
                    cooldownMs,
                    failureThreshold
                );
                lastTransportError = event.error;
            } else if (event.failureKind === 'domain') {
                sawDomainFailure = true;
            }

            startNextCandidate();
        }

        if (lastTransportError && !sawDomainFailure) {
            throw lastTransportError;
        }
        return null;
    } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
    }
}

export async function probeTelebirrProxyPool(
    reference: string,
    env: NodeJS.ProcessEnv = process.env
): Promise<TelebirrProbeDetails> {
    const descriptors = getTelebirrProxyDescriptors(env);
    const timeoutMs = positiveInteger(
        env.STATUS_PROBE_TELEBIRR_PROXY_TIMEOUT_MS,
        18_000
    );
    const proxyKey = env.TELEBIRR_PROXY_KEY ?? '';

    const routes = await Promise.all(
        descriptors.map(async (descriptor): Promise<TelebirrRouteStatus> => {
            const startedAt = performance.now();
            try {
                const receipt = await fetchFromProxySource(reference, descriptor.url, {
                    proxyKey,
                    timeoutMs,
                    relayLabel: descriptor.label
                });
                const operational = Boolean(receipt && isValidReceipt(receipt));
                const latencyMs = Math.round(performance.now() - startedAt);
                return {
                    id: descriptor.id,
                    label: descriptor.label,
                    role: descriptor.role,
                    status: operational ? 'operational' : 'unavailable',
                    latencyMs
                };
            } catch {
                return {
                    id: descriptor.id,
                    label: descriptor.label,
                    role: descriptor.role,
                    status: 'unavailable',
                    latencyMs: Math.round(performance.now() - startedAt)
                };
            }
        })
    );
    const active = routes.find(route => route.status === 'operational') ?? null;

    return {
        activeRouteId: active?.id ?? null,
        preferredRouteAvailable:
            routes.find(route => route.role === 'preferred')?.status === 'operational',
        routes
    };
}

export async function verifyTelebirr(reference: string): Promise<TelebirrReceipt | null> {
    const primaryUrl = "https://transactioninfo.ethiotelecom.et/receipt/";
    const proxyDescriptors = getTelebirrProxyDescriptors(process.env);
    const skipPrimary = process.env.SKIP_PRIMARY_VERIFICATION === "true";

    if (!skipPrimary) {
        logger.info('Attempting primary Telebirr verification.');
        const primaryResult = await fetchFromPrimarySource(reference, primaryUrl);

        if (primaryResult && isValidReceipt(primaryResult)) {
            return primaryResult;
        }
        logger.warn(`Primary verification failed. Moving to fallback proxy pool...`);
    } else {
        logger.info(`Skipping primary verifier (SKIP_PRIMARY_VERIFICATION=true).`);
    }

    if (proxyDescriptors.length === 0 && skipPrimary) {
        logger.error("CRITICAL: Primary check skipped, but no FALLBACK_PROXIES defined in .env!");
        return null;
    }

    if (proxyDescriptors.length > 0) {
        const fallbackResult = await verifyWithTelebirrProxyPool(
            reference,
            proxyDescriptors,
            process.env
        );
        if (fallbackResult) {
            return fallbackResult;
        }
    }

    logger.error('All Telebirr verification methods failed.');
    return null;
}

// Add this helper function to validate receipt data
function isValidReceipt(receipt: TelebirrReceipt): boolean {
    // Check if essential fields have values
    return Boolean(
        receipt.receiptNo &&
        receipt.payerName &&
        receipt.transactionStatus
    );
}
