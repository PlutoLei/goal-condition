import assert from 'node:assert/strict';
import test from 'node:test';

import { compileDraft } from '../src/compiler.mjs';
import { verifyConditions } from '../src/verification.mjs';
import { validDraft } from './helpers.mjs';

test('controller verifier hashes bounded output and can certify a clean Attempt', async () => {
  const { session } = compileDraft(validDraft());
  const result = await verifyConditions({
    session,
    attemptId: 'attempt-0001',
    runtimeVersionHash: 'b'.repeat(64),
    projectionHash: 'c'.repeat(64),
    snapshotHash: 'd'.repeat(64),
    now: '2026-08-11T00:00:00.000Z',
    runner: async () => ({ code: 0, stdout: Buffer.from('pass\n'), stderr: Buffer.alloc(0) }),
    bypasses: [],
  });
  assert.equal(result.completion.level, 'certified');
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].output_hash.length, 64);
  assert.equal(JSON.stringify(result.evidence).includes('pass'), false);
});

test('a bypass caps completion at Verified even when all verifiers pass', async () => {
  const { session } = compileDraft(validDraft());
  const result = await verifyConditions({
    session,
    attemptId: 'attempt-0001',
    runtimeVersionHash: 'b'.repeat(64),
    projectionHash: 'c'.repeat(64),
    snapshotHash: 'd'.repeat(64),
    now: '2026-08-11T00:00:00.000Z',
    runner: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    bypasses: [{ type: 'CONTROL_PLANE_BYPASS' }],
  });
  assert.equal(result.completion.level, 'verified');
  assert.deepEqual(result.completion.reason_codes, ['CONTROL_PLANE_BYPASS']);
});
