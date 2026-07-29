import { verifyAbyssinia } from './verifyAbyssinia';
import { verifyCBE } from './verifyCBE';
import { verifyCBEBirr } from './verifyCBEBirr';
import { verifyDashen } from './verifyDashen';
import { verifyMpesa } from './verifyMpesa';
import { verifyTelebirr } from './verifyTelebirr';
import type {
  StatusCapabilities,
  StatusProbeResult,
  StatusProvider,
  StatusProbeResultCode,
} from '../types/statusProbe';
import { runWithSensitiveLogsSuppressed } from '../utils/sensitiveLogContext';

const DEFAULT_TIMEOUT_MS = 35_000;
const DEFAULT_SLOW_MS = 10_000;

class ProbeTimeoutError extends Error {
  constructor() {
    super('Status provider probe timed out.');
    this.name = 'ProbeTimeoutError';
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function providerOperation(
  provider: StatusProvider,
  env: NodeJS.ProcessEnv,
): (() => Promise<boolean>) | null {
  switch (provider) {
    case 'telebirr': {
      const reference = env.STATUS_PROBE_TELEBIRR_REFERENCE;
      if (!reference?.trim()) return null;
      return async () => (await verifyTelebirr(reference)) !== null;
    }
    case 'cbe': {
      const reference = env.STATUS_PROBE_CBE_REFERENCE;
      if (!reference?.trim()) return null;
      return async () =>
        (await verifyCBE(reference, env.STATUS_PROBE_CBE_ACCOUNT_SUFFIX)).success;
    }
    case 'cbe-birr': {
      const reference = env.STATUS_PROBE_CBEBIRR_REFERENCE;
      const phone = env.STATUS_PROBE_CBEBIRR_PHONE;
      const apiKey = env.STATUS_PROBE_CBEBIRR_API_KEY;
      if (!reference?.trim() || !phone?.trim() || !apiKey?.trim()) return null;
      return async () => {
        const result = await verifyCBEBirr(reference, phone, apiKey);
        return !('success' in result) || result.success !== false;
      };
    }
    case 'dashen': {
      const reference = env.STATUS_PROBE_DASHEN_REFERENCE;
      if (!reference?.trim()) return null;
      return async () => (await verifyDashen(reference)).success;
    }
    case 'abyssinia': {
      const reference = env.STATUS_PROBE_ABYSSINIA_REFERENCE;
      const suffix = env.STATUS_PROBE_ABYSSINIA_ACCOUNT_SUFFIX;
      if (!reference?.trim() || !suffix?.trim()) return null;
      return async () => (await verifyAbyssinia(reference, suffix)).success;
    }
    case 'mpesa': {
      const reference = env.STATUS_PROBE_MPESA_REFERENCE;
      if (!reference?.trim()) return null;
      return async () => (await verifyMpesa(reference)).success;
    }
  }
}

export function classifyProbeResult(input: {
  configured: boolean;
  healthy: boolean;
  durationMs: number;
  slowMs?: number;
  error?: unknown;
}): StatusProbeResultCode {
  if (!input.configured) return 'PROBE_NOT_CONFIGURED';
  if (input.error instanceof ProbeTimeoutError) return 'UPSTREAM_TIMEOUT';
  if (input.error) return 'UPSTREAM_UNAVAILABLE';
  if (!input.healthy) return 'UNEXPECTED_RESPONSE';
  return input.durationMs >= (input.slowMs ?? DEFAULT_SLOW_MS)
    ? 'UPSTREAM_SLOW'
    : 'PROBE_OK';
}

export async function runStatusProviderProbe(
  provider: StatusProvider,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StatusProbeResult> {
  const checkedAt = new Date().toISOString();
  const operation = providerOperation(provider, env);
  if (!operation) {
    return {
      provider,
      reachable: false,
      verificationPathHealthy: false,
      durationMs: 0,
      checkedAt,
      resultCode: 'PROBE_NOT_CONFIGURED',
    };
  }

  const timeoutMs = parsePositiveInteger(env.STATUS_PROBE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const slowMs = parsePositiveInteger(env.STATUS_PROBE_SLOW_MS, DEFAULT_SLOW_MS);
  const startedAt = performance.now();
  let healthy = false;
  let error: unknown;
  try {
    healthy = await runWithSensitiveLogsSuppressed(() =>
      withTimeout(operation(), timeoutMs),
    );
  } catch (caught) {
    error = caught;
  }
  const durationMs = Math.round(performance.now() - startedAt);
  const resultCode = classifyProbeResult({
    configured: true,
    healthy,
    durationMs,
    slowMs,
    error,
  });

  return {
    provider,
    reachable: resultCode === 'PROBE_OK' || resultCode === 'UPSTREAM_SLOW',
    verificationPathHealthy:
      resultCode === 'PROBE_OK' || resultCode === 'UPSTREAM_SLOW',
    durationMs,
    checkedAt,
    resultCode,
  };
}

function optionalBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

export function getStatusCapabilities(
  env: NodeJS.ProcessEnv = process.env,
): StatusCapabilities {
  return {
    batchVerification: {
      configured: optionalBoolean(env.STATUS_CAPABILITY_BATCH_ENABLED, true),
    },
    imageVerification: {
      configured: optionalBoolean(
        env.STATUS_CAPABILITY_IMAGE_ENABLED,
        Boolean(env.MISTRAL_API_KEY),
      ),
    },
    hostedCommerce: {
      configured: optionalBoolean(
        env.STATUS_CAPABILITY_COMMERCE_ENABLED,
        Boolean(env.DATABASE_URL),
      ),
    },
    checkedAt: new Date().toISOString(),
  };
}
