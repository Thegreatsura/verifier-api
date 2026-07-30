import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  classifyProbeResult,
  getStatusCapabilities,
  isHealthyProbeResultCode,
  runStatusProviderProbe,
} from '../services/statusProbeService';
import {
  getTelebirrProxyDescriptors,
  TelebirrVerificationError,
  verifyTelebirr,
} from '../services/verifyTelebirr';

const TELEBIRR_ENV_KEYS = [
  'FALLBACK_PROXIES',
  'SKIP_PRIMARY_VERIFICATION',
  'STATUS_PROBE_TELEBIRR_PROXY_TIMEOUT_MS',
  'STATUS_PROBE_TELEBIRR_REFERENCE',
  'TELEBIRR_HEDGE_DELAY_MS',
  'TELEBIRR_MAX_PARALLEL_PROXIES',
  'TELEBIRR_PROXY_COOLDOWN_MS',
  'TELEBIRR_PROXY_FAILURE_THRESHOLD',
  'TELEBIRR_PROXY_KEY',
  'TELEBIRR_PROXY_TIMEOUT_MS',
  'TELEBIRR_TOTAL_TIMEOUT_MS',
] as const;

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; proxyUrl: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    proxyUrl: `http://127.0.0.1:${address.port}/?reference=`,
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

function validTelebirrResponse(receiptNo: string): string {
  return JSON.stringify({
    success: true,
    data: {
      payerName: 'Status test payer',
      transactionStatus: 'Completed',
      receiptNo,
    },
  });
}

async function withTelebirrEnv(
  values: Record<string, string>,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = new Map(
    TELEBIRR_ENV_KEYS.map(key => [key, process.env[key]]),
  );
  try {
    for (const key of TELEBIRR_ENV_KEYS) delete process.env[key];
    Object.assign(process.env, values);
    await operation();
  } finally {
    for (const key of TELEBIRR_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('returns a redacted not-configured provider result without contacting upstreams', async () => {
  const result = await runStatusProviderProbe('telebirr', {});
  assert.deepEqual(
    {
      provider: result.provider,
      reachable: result.reachable,
      verificationPathHealthy: result.verificationPathHealthy,
      durationMs: result.durationMs,
      resultCode: result.resultCode,
    },
    {
      provider: 'telebirr',
      reachable: false,
      verificationPathHealthy: false,
      durationMs: 0,
      resultCode: 'PROBE_NOT_CONFIGURED',
    },
  );
  assert.equal('reference' in result, false);
  assert.equal('error' in result, false);
});

test('classifies healthy, slow, invalid, and unavailable results', () => {
  assert.equal(
    classifyProbeResult({ configured: true, healthy: true, durationMs: 100 }),
    'PROBE_OK',
  );
  assert.equal(
    classifyProbeResult({
      configured: true,
      healthy: true,
      durationMs: 10_001,
    }),
    'UPSTREAM_SLOW',
  );
  assert.equal(
    classifyProbeResult({ configured: true, healthy: false, durationMs: 100 }),
    'UNEXPECTED_RESPONSE',
  );
  assert.equal(
    classifyProbeResult({
      configured: true,
      healthy: false,
      durationMs: 100,
      error: new Error('unavailable'),
    }),
    'UPSTREAM_UNAVAILABLE',
  );
});

test('treats an active fallback Telebirr relay as a healthy degraded path', () => {
  assert.equal(isHealthyProbeResultCode('FALLBACK_ACTIVE'), true);
  assert.equal(isHealthyProbeResultCode('ALL_ROUTES_UNAVAILABLE'), false);
});

test('reports capability configuration without consuming credits', () => {
  const capabilities = getStatusCapabilities({
    MISTRAL_API_KEY: 'configured',
    DATABASE_URL: 'configured',
  });
  assert.equal(capabilities.batchVerification.configured, true);
  assert.equal(capabilities.imageVerification.configured, true);
  assert.equal(capabilities.hostedCommerce.configured, true);
});

test('creates safe public Telebirr relay labels without exposing fallback URLs', () => {
  const descriptors = getTelebirrProxyDescriptors({
    FALLBACK_PROXIES:
      'https://leul.et/telebirr?reference=,https://private-relay.example/check?reference=',
    TELEBIRR_PROXY_LABELS: 'leul.et,Community relay 1',
  });
  assert.deepEqual(
    descriptors.map(({ id, label, role }) => ({ id, label, role })),
    [
      { id: 'preferred', label: 'leul.et', role: 'preferred' },
      { id: 'relay-1', label: 'Community relay 1', role: 'fallback' },
    ],
  );
});

test('hedges a slow preferred relay and reuses the winning fallback', async () => {
  let preferredRequests = 0;
  let fallbackRequests = 0;
  const preferred = await listen((_request, response) => {
    preferredRequests += 1;
    setTimeout(() => {
      if (response.destroyed) return;
      response.setHeader('content-type', 'application/json');
      response.end(validTelebirrResponse('PREFERRED'));
    }, 300);
  });
  const fallback = await listen((_request, response) => {
    fallbackRequests += 1;
    response.setHeader('content-type', 'application/json');
    response.end(validTelebirrResponse('FALLBACK'));
  });

  try {
    await withTelebirrEnv(
      {
        FALLBACK_PROXIES: `${preferred.proxyUrl},${fallback.proxyUrl}`,
        SKIP_PRIMARY_VERIFICATION: 'true',
        TELEBIRR_HEDGE_DELAY_MS: '40',
        TELEBIRR_MAX_PARALLEL_PROXIES: '2',
        TELEBIRR_PROXY_COOLDOWN_MS: '5000',
        TELEBIRR_PROXY_TIMEOUT_MS: '1000',
        TELEBIRR_TOTAL_TIMEOUT_MS: '1500',
      },
      async () => {
        const first = await verifyTelebirr('TEST-REFERENCE');
        assert.equal(first?.receiptNo, 'FALLBACK');
        assert.equal(preferredRequests, 1);
        assert.equal(fallbackRequests, 1);

        const second = await verifyTelebirr('TEST-REFERENCE');
        assert.equal(second?.receiptNo, 'FALLBACK');
        await new Promise(resolve => setTimeout(resolve, 75));
        assert.equal(
          preferredRequests,
          1,
          'the known active fallback should satisfy the request before another hedge',
        );
        assert.equal(fallbackRequests, 2);
      },
    );
  } finally {
    await Promise.all([
      closeServer(preferred.server),
      closeServer(fallback.server),
    ]);
  }
});

test('opens the circuit only after the configured transport-failure threshold', async () => {
  let preferredRequests = 0;
  const preferred = await listen((_request, response) => {
    preferredRequests += 1;
    response.statusCode = 503;
    response.end('unavailable');
  });
  const fallback = await listen((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ success: false, error: 'Receipt not found' }));
  });

  try {
    await withTelebirrEnv(
      {
        FALLBACK_PROXIES: `${preferred.proxyUrl},${fallback.proxyUrl}`,
        SKIP_PRIMARY_VERIFICATION: 'true',
        TELEBIRR_HEDGE_DELAY_MS: '20',
        TELEBIRR_MAX_PARALLEL_PROXIES: '2',
        TELEBIRR_PROXY_COOLDOWN_MS: '5000',
        TELEBIRR_PROXY_FAILURE_THRESHOLD: '2',
        TELEBIRR_PROXY_TIMEOUT_MS: '500',
        TELEBIRR_TOTAL_TIMEOUT_MS: '1000',
      },
      async () => {
        assert.equal(await verifyTelebirr('TEST-REFERENCE'), null);
        assert.equal(await verifyTelebirr('TEST-REFERENCE'), null);
        assert.equal(await verifyTelebirr('TEST-REFERENCE'), null);
        assert.equal(
          preferredRequests,
          2,
          'one transient failure should be retried before the circuit opens',
        );
      },
    );
  } finally {
    await Promise.all([
      closeServer(preferred.server),
      closeServer(fallback.server),
    ]);
  }
});

test('status probes do not change live Telebirr relay routing state', async () => {
  let preferredHealthy = false;
  const preferred = await listen((_request, response) => {
    if (!preferredHealthy) {
      response.statusCode = 503;
      response.end('temporarily unavailable');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(validTelebirrResponse('PREFERRED-RECOVERED'));
  });
  const fallback = await listen((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(validTelebirrResponse('FALLBACK-STATUS'));
  });

  try {
    await withTelebirrEnv(
      {
        FALLBACK_PROXIES: `${preferred.proxyUrl},${fallback.proxyUrl}`,
        SKIP_PRIMARY_VERIFICATION: 'true',
        STATUS_PROBE_TELEBIRR_REFERENCE: 'TEST-REFERENCE',
        STATUS_PROBE_TELEBIRR_PROXY_TIMEOUT_MS: '500',
        TELEBIRR_HEDGE_DELAY_MS: '100',
        TELEBIRR_MAX_PARALLEL_PROXIES: '2',
        TELEBIRR_PROXY_COOLDOWN_MS: '5000',
        TELEBIRR_PROXY_FAILURE_THRESHOLD: '1',
        TELEBIRR_PROXY_TIMEOUT_MS: '500',
        TELEBIRR_TOTAL_TIMEOUT_MS: '1000',
      },
      async () => {
        const probe = await runStatusProviderProbe('telebirr', process.env);
        assert.equal(probe.resultCode, 'FALLBACK_ACTIVE');

        preferredHealthy = true;
        const verification = await verifyTelebirr('TEST-REFERENCE');
        assert.equal(verification?.receiptNo, 'PREFERRED-RECOVERED');
      },
    );
  } finally {
    await Promise.all([
      closeServer(preferred.server),
      closeServer(fallback.server),
    ]);
  }
});

test('allows a half-open recovery attempt when every relay circuit is open', async () => {
  let healthy = false;
  let requests = 0;
  const relay = await listen((_request, response) => {
    requests += 1;
    if (!healthy) {
      response.statusCode = 503;
      response.end('temporarily unavailable');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(validTelebirrResponse('HALF-OPEN-RECOVERY'));
  });

  try {
    await withTelebirrEnv(
      {
        FALLBACK_PROXIES: relay.proxyUrl,
        SKIP_PRIMARY_VERIFICATION: 'true',
        TELEBIRR_PROXY_COOLDOWN_MS: '5000',
        TELEBIRR_PROXY_FAILURE_THRESHOLD: '1',
        TELEBIRR_PROXY_TIMEOUT_MS: '500',
        TELEBIRR_TOTAL_TIMEOUT_MS: '1000',
      },
      async () => {
        await assert.rejects(
          () => verifyTelebirr('TEST-REFERENCE'),
          (error: unknown) =>
            error instanceof TelebirrVerificationError &&
            error.kind === 'transport',
        );

        healthy = true;
        const recovered = await verifyTelebirr('TEST-REFERENCE');
        assert.equal(recovered?.receiptNo, 'HALF-OPEN-RECOVERY');
        assert.equal(requests, 2);
      },
    );
  } finally {
    await closeServer(relay.server);
  }
});

test('surfaces an all-relay transport failure instead of reporting receipt not found', async () => {
  const relay = await listen((_request, response) => {
    response.statusCode = 502;
    response.end('bad gateway');
  });

  try {
    await withTelebirrEnv(
      {
        FALLBACK_PROXIES: relay.proxyUrl,
        SKIP_PRIMARY_VERIFICATION: 'true',
        TELEBIRR_PROXY_FAILURE_THRESHOLD: '2',
        TELEBIRR_PROXY_TIMEOUT_MS: '500',
        TELEBIRR_TOTAL_TIMEOUT_MS: '1000',
      },
      async () => {
        await assert.rejects(
          () => verifyTelebirr('TEST-REFERENCE'),
          (error: unknown) =>
            error instanceof TelebirrVerificationError &&
            error.kind === 'transport',
        );
      },
    );
  } finally {
    await closeServer(relay.server);
  }
});

test('does not open a relay circuit for a missing receipt', async () => {
  let preferredHasReceipt = false;
  let preferredRequests = 0;
  const preferred = await listen((_request, response) => {
    preferredRequests += 1;
    response.setHeader('content-type', 'application/json');
    response.end(
      preferredHasReceipt
        ? validTelebirrResponse('RECOVERED-PREFERRED')
        : JSON.stringify({ success: false, error: 'Receipt not found' }),
    );
  });
  const fallback = await listen((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ success: false, error: 'Receipt not found' }));
  });

  try {
    await withTelebirrEnv(
      {
        FALLBACK_PROXIES: `${preferred.proxyUrl},${fallback.proxyUrl}`,
        SKIP_PRIMARY_VERIFICATION: 'true',
        TELEBIRR_HEDGE_DELAY_MS: '20',
        TELEBIRR_MAX_PARALLEL_PROXIES: '2',
        TELEBIRR_PROXY_COOLDOWN_MS: '5000',
        TELEBIRR_PROXY_TIMEOUT_MS: '500',
        TELEBIRR_TOTAL_TIMEOUT_MS: '1000',
      },
      async () => {
        assert.equal(await verifyTelebirr('MISSING-REFERENCE'), null);
        preferredHasReceipt = true;
        assert.equal(
          (await verifyTelebirr('TEST-REFERENCE'))?.receiptNo,
          'RECOVERED-PREFERRED',
        );
        assert.equal(preferredRequests, 2);
      },
    );
  } finally {
    await Promise.all([
      closeServer(preferred.server),
      closeServer(fallback.server),
    ]);
  }
});
