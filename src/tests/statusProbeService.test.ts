import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyProbeResult,
  getStatusCapabilities,
  runStatusProviderProbe,
} from '../services/statusProbeService';

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

test('reports capability configuration without consuming credits', () => {
  const capabilities = getStatusCapabilities({
    MISTRAL_API_KEY: 'configured',
    DATABASE_URL: 'configured',
  });
  assert.equal(capabilities.batchVerification.configured, true);
  assert.equal(capabilities.imageVerification.configured, true);
  assert.equal(capabilities.hostedCommerce.configured, true);
});
