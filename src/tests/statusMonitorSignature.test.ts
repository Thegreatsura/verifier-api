import assert from 'node:assert/strict';
import test from 'node:test';
import {
  signStatusRequest,
  verifyStatusSignature,
} from '../middleware/statusMonitorSignature';

const secret = 'unit-test-status-monitor-secret';
const timestamp = 1_725_000_000_000;
const path = '/internal/status/probe/telebirr';

test('accepts a valid status monitor signature', () => {
  const signature = signStatusRequest(secret, timestamp, 'POST', path);
  assert.equal(
    verifyStatusSignature({
      secret,
      timestampHeader: String(timestamp),
      signatureHeader: signature,
      method: 'POST',
      originalPath: path,
      now: timestamp,
    }),
    true,
  );
});

test('rejects altered paths, methods, malformed signatures, and expired timestamps', () => {
  const signature = signStatusRequest(secret, timestamp, 'POST', path);
  const base = {
    secret,
    timestampHeader: String(timestamp),
    signatureHeader: signature,
    method: 'POST',
    originalPath: path,
    now: timestamp,
  };
  assert.equal(verifyStatusSignature({ ...base, originalPath: `${path}/changed` }), false);
  assert.equal(verifyStatusSignature({ ...base, method: 'GET' }), false);
  assert.equal(verifyStatusSignature({ ...base, signatureHeader: 'not-hex' }), false);
  assert.equal(verifyStatusSignature({ ...base, now: timestamp + 60_001 }), false);
});
