import assert from 'node:assert/strict';
import test from 'node:test';

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  assertLiveRollout,
  certifyRolloutCanary,
  readRolloutState,
  transitionRollout,
  writeRolloutMode,
} from '../src/rollout.mjs';

const RELEASE_DIGEST = '9'.repeat(64);

function certifiedCanaryExport() {
  const first = {
    attempt_id: 'attempt-old', run_id: 'run-old', status: 'Rejected', completion_level: 'candidate',
  };
  const receipt = {
    receipt_version: 1, session_id: 'session-canary', attempt_id: 'attempt-certified',
    run_id: 'run-certified', intent_hash: 'a'.repeat(64), thread_id: 'thread-canary',
    turn_id: 'turn-canary', authorized_turn_ids: ['turn-canary'],
    started_at: '2026-08-11T00:00:00.000Z',
  };
  const certified = {
    attempt_id: 'attempt-certified', run_id: 'run-certified', status: 'Verified',
    completion_level: 'certified', design_revision_hash: 'b'.repeat(64),
    controller_release_digest: RELEASE_DIGEST,
    bypasses: [], launch_receipt: receipt,
  };
  return {
    session: {
      session_id: 'session-canary', status: 'Complete', authorization_hash: 'c'.repeat(64),
      authority_revisions: [{ revision: 1 }],
      confirmation_receipts: [{ receipt_version: 1 }],
      design_revisions: [
        { revision: 1, design_revision_hash: 'd'.repeat(64), conditions: [{ id: 'condition-base' }] },
        {
          revision: 2, design_revision_hash: 'b'.repeat(64),
          conditions: [{ id: 'condition-base' }, { id: 'condition-added' }],
        },
      ],
      attempts: [first, certified],
      evidence: [
        { attempt_id: 'attempt-certified', condition_id: 'condition-base', controller_owned: true, result: 'pass' },
        { attempt_id: 'attempt-certified', condition_id: 'condition-added', controller_owned: true, result: 'pass' },
      ],
    },
    events: [{ event_type: 'GOAL_SESSION_CERTIFIED', event_hash: 'e'.repeat(64) }],
  };
}

test('rollout follows the closed shadow to default sequence', () => {
  assert.equal(transitionRollout('shadow', 'opt-in'), 'opt-in');
  const receipt = certifyRolloutCanary(certifiedCanaryExport(), {
    releaseManifestDigest: RELEASE_DIGEST,
  });
  assert.equal(transitionRollout('opt-in', 'default', { canaryReceipt: receipt }), 'default');
  assert.equal(transitionRollout('default', 'legacy-freeze', { canaryReceipt: receipt }), 'legacy-freeze');
});

test('rollout cannot skip recovery gates', () => {
  assert.throws(
    () => transitionRollout('shadow', 'default'),
    (error) => error.code === 'ROLLOUT_TRANSITION_INVALID',
  );
  assert.throws(
    () => transitionRollout('opt-in', 'default'),
    (error) => error.code === 'ROLLOUT_CANARY_REQUIRED',
  );
});

test('default rollout is bound to one live certified dynamic-revision canary receipt', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'goal-condition-rollout-canary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'rollout.json');
  const receipt = certifyRolloutCanary(certifiedCanaryExport(), {
    releaseManifestDigest: RELEASE_DIGEST,
  });
  writeRolloutMode({
    path, current: 'shadow', next: 'opt-in', changedAt: '2026-08-11T00:00:00.000Z',
  });
  writeRolloutMode({
    path, current: 'opt-in', next: 'default', changedAt: '2026-08-11T00:01:00.000Z',
    canaryReceipt: receipt,
  });
  const state = readRolloutState(path);
  assert.equal(state.mode, 'default');
  assert.equal(state.schema_version, 3);
  assert.equal(state.release_manifest_digest, RELEASE_DIGEST);
  assert.deepEqual(state.canary_receipt, receipt);
  assert.equal(assertLiveRollout(root, { releaseManifestDigest: RELEASE_DIGEST }), 'default');
  assert.throws(
    () => assertLiveRollout(root, { releaseManifestDigest: '8'.repeat(64) }),
    (error) => error.code === 'ROLLOUT_RELEASE_MISMATCH',
  );
});

test('a canary from another controller release cannot promote the current release', () => {
  assert.throws(
    () => certifyRolloutCanary(certifiedCanaryExport(), {
      releaseManifestDigest: '8'.repeat(64),
    }),
    (error) => error.code === 'ROLLOUT_CANARY_INVALID',
  );
});

test('live GoalSession commands fail closed in shadow and open only after opt-in', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'goal-condition-rollout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(root, { recursive: true });
  assert.throws(
    () => assertLiveRollout(root),
    (error) => error.code === 'ROLLOUT_LIVE_BLOCKED',
  );
  writeRolloutMode({
    path: join(root, 'rollout.json'), current: 'shadow', next: 'opt-in',
    changedAt: '2026-08-11T00:00:00.000Z',
  });
  assert.equal(assertLiveRollout(root), 'opt-in');
});
