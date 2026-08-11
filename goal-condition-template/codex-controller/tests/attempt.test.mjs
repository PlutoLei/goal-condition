import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLaunchIntent,
  createLaunchReceipt,
  realizeAttempt,
  verifyLaunchCapability,
} from '../src/attempt.mjs';

const HASH = 'a'.repeat(64);
const KEY = Buffer.alloc(32, 7);

test('LaunchIntent and LaunchReceipt bind one native turn to one immutable Attempt', () => {
  const intent = createLaunchIntent({
    sessionId: 'session-0001',
    attemptId: 'attempt-0001',
    designRevisionHash: HASH,
    attemptHash: 'b'.repeat(64),
    contractHash: 'c'.repeat(64),
    contextPackageHash: 'd'.repeat(64),
    projectionProofHash: 'e'.repeat(64),
    workspaceDigest: 'f'.repeat(64),
    runId: 'run-0001',
    nonce: '00112233445566778899aabbccddeeff',
    expiresAt: '2026-08-12T00:00:00.000Z',
    key: KEY,
    keyId: 'controller-key-v1',
  });
  assert.equal(verifyLaunchCapability({ intent, key: KEY }), true);

  const receipt = createLaunchReceipt({
    intent,
    threadId: 'thread-native-1',
    turnId: 'turn-native-1',
    startedAt: '2026-08-11T00:00:00.000Z',
  });
  const attempt = realizeAttempt({ intent, receipt });
  assert.equal(attempt.status, 'Launched');
  assert.equal(attempt.launch_receipt.thread_id, 'thread-native-1');
  assert.equal(attempt.run_id, 'run-0001');
});

test('a tampered intent cannot be replayed as a valid capability', () => {
  const intent = createLaunchIntent({
    sessionId: 'session-0001', attemptId: 'attempt-0001', designRevisionHash: HASH,
    attemptHash: 'b'.repeat(64), contractHash: 'c'.repeat(64),
    contextPackageHash: 'd'.repeat(64), projectionProofHash: 'e'.repeat(64),
    workspaceDigest: 'f'.repeat(64), runId: 'run-0001',
    nonce: '00112233445566778899aabbccddeeff', expiresAt: '2026-08-12T00:00:00.000Z',
    key: KEY, keyId: 'controller-key-v1',
  });
  assert.equal(verifyLaunchCapability({ intent: { ...intent, run_id: 'run-0002' }, key: KEY }), false);
});
