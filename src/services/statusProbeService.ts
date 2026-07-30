import { verifyAbyssinia } from './verifyAbyssinia';
import { verifyCBE } from './verifyCBE';
import { verifyCBEBirr } from './verifyCBEBirr';
import { verifyDashen } from './verifyDashen';
import { probeTelebirrProxyPool } from './verifyTelebirr';
import type {
  StatusCapabilities,
  TelebirrProbeDetails,
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
): (() => Promise<{ healthy: boolean; telebirr?: TelebirrProbeDetails }>) | null {
  switch (provider) {
    case 'telebirr': {
      const reference = env.STATUS_PROBE_TELEBIRR_REFERENCE;
      if (!reference?.trim()) return null;
      return async () => {
        const telebirr = await probeTelebirrProxyPool(reference, env);
        return {
          healthy: Boolean(telebirr.activeRouteId),
          telebirr,
        };
      };
    }
    case 'cbe': {
      const reference =
        env.STATUS_PROBE_CBE_LEGACY_REFERENCE ??
        env.STATUS_PROBE_CBE_REFERENCE;
      const suffix =
        env.STATUS_PROBE_CBE_LEGACY_ACCOUNT_SUFFIX ??
        env.STATUS_PROBE_CBE_ACCOUNT_SUFFIX;
      if (!reference?.trim() || !suffix?.trim()) return null;
      return async () => ({
        healthy: (await verifyCBE(reference, suffix)).success,
      });
    }
    case 'cbe-new': {
      const receiptUrl = env.STATUS_PROBE_CBE_NEW_URL;
      if (!receiptUrl?.trim()) return null;
      return async () => ({
        healthy: (await verifyCBE(receiptUrl)).success,
      });
    }
    case 'cbe-birr': {
      const reference = env.STATUS_PROBE_CBEBIRR_REFERENCE;
      const phone = env.STATUS_PROBE_CBEBIRR_PHONE;
      if (!reference?.trim() || !phone?.trim()) return null;
      return async () => {
        const result = await verifyCBEBirr(reference, phone);
        return {
          healthy: !('success' in result) || result.success !== false,
        };
      };
    }
    case 'dashen': {
      const reference = env.STATUS_PROBE_DASHEN_REFERENCE;
      if (!reference?.trim()) return null;
      return async () => ({
        healthy: (await verifyDashen(reference)).success,
      });
    }
    case 'abyssinia': {
      const reference = env.STATUS_PROBE_ABYSSINIA_REFERENCE;
      const suffix = env.STATUS_PROBE_ABYSSINIA_ACCOUNT_SUFFIX;
      if (!reference?.trim() || !suffix?.trim()) return null;
      return async () => ({
        healthy: (await verifyAbyssinia(reference, suffix)).success,
      });
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

export function isHealthyProbeResultCode(
  resultCode: StatusProbeResultCode,
): boolean {
  return (
    resultCode === 'PROBE_OK' ||
    resultCode === 'UPSTREAM_SLOW' ||
    resultCode === 'FALLBACK_ACTIVE'
  );
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
  let telebirr: TelebirrProbeDetails | undefined;
  let error: unknown;
  try {
    const outcome = await runWithSensitiveLogsSuppressed(() =>
      withTimeout(operation(), timeoutMs),
    );
    healthy = outcome.healthy;
    telebirr = outcome.telebirr;
  } catch (caught) {
    error = caught;
  }
  const durationMs = Math.round(performance.now() - startedAt);
  let resultCode = classifyProbeResult({
    configured: true,
    healthy,
    durationMs,
    slowMs,
    error,
  });
  if (telebirr) {
    if (!telebirr.activeRouteId) {
      resultCode = 'ALL_ROUTES_UNAVAILABLE';
    } else if (!telebirr.preferredRouteAvailable) {
      resultCode = 'FALLBACK_ACTIVE';
    }
  }

  const pathHealthy = isHealthyProbeResultCode(resultCode);

  return {
    provider,
    reachable: pathHealthy,
    verificationPathHealthy: pathHealthy,
    durationMs,
    checkedAt,
    resultCode,
    ...(telebirr ? { telebirr } : {}),
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
