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

test('a matching v3 continuation lineage safely continues evaluation', () => {
  const result = reconcileLaunch({
    intent: { run_id: 'run-1', attempt_id: 'attempt-1' },
    receipt: {
      receipt_version: 3,
      run_id: 'run-1', thread_id: 'thread-1', turn_id: 'turn-root',
      turn_input_sha256: '7'.repeat(64),
      authorized_turn_ids: ['turn-root', 'turn-continuation-1', 'turn-continuation-2'],
    },
    native: {
      available: true, thread_id: 'thread-1',
      turns: [
        { id: 'turn-root', input_sha256: '7'.repeat(64), input_kind: 'controller' },
        { id: 'turn-continuation-1', input_sha256: null, input_kind: 'continuation' },
        { id: 'turn-continuation-2', input_sha256: null, input_kind: 'continuation' },
      ],
    },
  });
  assert.equal(result.disposition, 'continue_evaluating');
  assert.equal(result.relaunch_allowed, false);
});

test('v3 continuation lineage rejects an input-bearing later turn', () => {
  const result = reconcileLaunch({
    intent: { run_id: 'run-1', attempt_id: 'attempt-1' },
    receipt: {
      receipt_version: 3,
      run_id: 'run-1', thread_id: 'thread-1', turn_id: 'turn-root',
      turn_input_sha256: '7'.repeat(64),
      authorized_turn_ids: ['turn-root', 'turn-external'],
    },
    native: {
      available: true, thread_id: 'thread-1',
      turns: [
        { id: 'turn-root', input_sha256: '7'.repeat(64), input_kind: 'controller' },
        { id: 'turn-external', input_sha256: '8'.repeat(64), input_kind: 'controller' },
      ],
    },
  });
  assert.equal(result.disposition, 'control_plane_bypass');
  assert.deepEqual(result.reason_codes, ['UNRECEIPTED_NATIVE_TURN']);
});

test('v3 continuation lineage rejects reordered persisted turns', () => {
  const result = reconcileLaunch({
    intent: { run_id: 'run-1', attempt_id: 'attempt-1' },
    receipt: {
      receipt_version: 3,
      run_id: 'run-1', thread_id: 'thread-1', turn_id: 'turn-root',
      turn_input_sha256: '7'.repeat(64),
      authorized_turn_ids: ['turn-root', 'turn-continuation'],
    },
    native: {
      available: true, thread_id: 'thread-1',
      turns: [
        { id: 'turn-continuation', input_sha256: null, input_kind: 'continuation' },
        { id: 'turn-root', input_sha256: '7'.repeat(64), input_kind: 'controller' },
      ],
    },
  });
  assert.notEqual(result.disposition, 'continue_evaluating');
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
