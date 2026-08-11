import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileLaunch } from '../src/recovery.mjs';

test('ambiguous launch is retained for reconciliation and never authorizes relaunch', () => {
  const result = reconcileLaunch({
    intent: { run_id: 'run-1', attempt_id: 'attempt-1' },
    receipt: null,
    native: { available: false },
  });
  assert.deepEqual(result, {
    disposition: 'reconciliation_required',
    relaunch_allowed: false,
    reason_codes: ['NATIVE_READBACK_UNAVAILABLE'],
  });
});

test('an unreceipted native turn is a control-plane bypass', () => {
  const result = reconcileLaunch({
    intent: { run_id: 'run-1', attempt_id: 'attempt-1' },
    receipt: null,
    native: { available: true, thread_id: 'thread-1', turns: [{ id: 'turn-1' }] },
  });
  assert.equal(result.disposition, 'control_plane_bypass');
  assert.equal(result.relaunch_allowed, false);
  assert.equal(result.reason_codes.includes('CONTROL_PLANE_BYPASS'), true);
});

test('a matching receipt and native turn safely continue evaluation', () => {
  const result = reconcileLaunch({
    intent: { run_id: 'run-1', attempt_id: 'attempt-1' },
    receipt: {
      run_id: 'run-1', thread_id: 'thread-1', turn_id: 'turn-1',
      turn_input_sha256: '7'.repeat(64),
      authorized_turn_ids: ['turn-1'],
    },
    native: {
      available: true, thread_id: 'thread-1',
      turns: [{ id: 'turn-1', input_sha256: '7'.repeat(64) }],
    },
  });
  assert.equal(result.disposition, 'continue_evaluating');
  assert.equal(result.relaunch_allowed, false);
});

test('a native turn added after the controller receipt is a control-plane bypass', () => {
  const result = reconcileLaunch({
    intent: { run_id: 'run-1', attempt_id: 'attempt-1' },
    receipt: {
      run_id: 'run-1', thread_id: 'thread-1', turn_id: 'turn-1',
      turn_input_sha256: '7'.repeat(64),
      authorized_turn_ids: ['turn-1'],
    },
    native: {
      available: true,
      thread_id: 'thread-1',
      turns: [
        { id: 'turn-1', input_sha256: '7'.repeat(64) },
        { id: 'turn-unreceipted', input_sha256: '8'.repeat(64) },
      ],
    },
  });
  assert.equal(result.disposition, 'control_plane_bypass');
  assert.equal(result.relaunch_allowed, false);
  assert.deepEqual(result.reason_codes, ['UNRECEIPTED_NATIVE_TURN']);
});

test('a matching id with a different persisted input is a control-plane bypass', () => {
  const result = reconcileLaunch({
    intent: { run_id: 'run-1', attempt_id: 'attempt-1' },
    receipt: {
      run_id: 'run-1', thread_id: 'thread-1', turn_id: 'turn-1',
      turn_input_sha256: '7'.repeat(64),
      authorized_turn_ids: ['turn-1'],
    },
    native: {
      available: true, thread_id: 'thread-1',
      turns: [{ id: 'turn-1', input_sha256: '8'.repeat(64) }],
    },
  });
  assert.equal(result.disposition, 'control_plane_bypass');
  assert.deepEqual(result.reason_codes, ['UNRECEIPTED_NATIVE_TURN']);
});

test('duplicate native turn ids never continue evaluation', () => {
  const result = reconcileLaunch({
    intent: { run_id: 'run-1', attempt_id: 'attempt-1' },
    receipt: {
      run_id: 'run-1', thread_id: 'thread-1', turn_id: 'turn-1',
      turn_input_sha256: '7'.repeat(64),
      authorized_turn_ids: ['turn-1'],
    },
    native: {
      available: true, thread_id: 'thread-1',
      turns: [
        { id: 'turn-1', input_sha256: '7'.repeat(64) },
        { id: 'turn-1', input_sha256: '7'.repeat(64) },
      ],
    },
  });
  assert.equal(result.disposition, 'reconciliation_required');
  assert.deepEqual(result.reason_codes, ['LAUNCH_RECEIPT_READBACK_MISMATCH']);
});
