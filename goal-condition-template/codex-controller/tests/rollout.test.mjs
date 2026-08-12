import assert from 'node:assert/strict';
import test from 'node:test';

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ROLLOUT_MODES,
  assertLiveRollout,
  certifyRolloutCanary,
  ensureRolloutState,
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
    receipt_version: 2, session_id: 'session-canary', attempt_id: 'attempt-certified',
    run_id: 'run-certified', intent_hash: 'a'.repeat(64), thread_id: 'thread-canary',
    turn_start_response_id: 'turn-start-response-canary',
    turn_input_sha256: '6'.repeat(64),
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

test('rollout follows the closed V2-only disabled to enabled sequence', () => {
  assert.deepEqual(ROLLOUT_MODES, ['disabled', 'canary', 'enabled']);
  assert.equal(transitionRollout('disabled', 'canary'), 'canary');
  const receipt = certifyRolloutCanary(certifiedCanaryExport(), {
    releaseManifestDigest: RELEASE_DIGEST,
  });
  assert.equal(transitionRollout('canary', 'enabled', { canaryReceipt: receipt }), 'enabled');
  assert.equal(transitionRollout('enabled', 'canary'), 'canary');
  assert.equal(transitionRollout('canary', 'disabled'), 'disabled');
});

test('rollout cannot skip recovery gates', () => {
  assert.throws(
    () => transitionRollout('disabled', 'enabled'),
    (error) => error.code === 'ROLLOUT_TRANSITION_INVALID',
  );
  assert.throws(
    () => transitionRollout('canary', 'enabled'),
    (error) => error.code === 'ROLLOUT_CANARY_REQUIRED',
  );
});

test('enabled rollout is bound to one live certified dynamic-revision canary receipt', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'goal-condition-rollout-canary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'rollout.json');
  const receipt = certifyRolloutCanary(certifiedCanaryExport(), {
    releaseManifestDigest: RELEASE_DIGEST,
  });
  writeRolloutMode({
    path, current: 'disabled', next: 'canary', changedAt: '2026-08-11T00:00:00.000Z',
    releaseManifestDigest: RELEASE_DIGEST,
  });
  writeRolloutMode({
    path, current: 'canary', next: 'enabled', changedAt: '2026-08-11T00:01:00.000Z',
    canaryReceipt: receipt, releaseManifestDigest: RELEASE_DIGEST,
  });
  const state = readRolloutState(path);
  assert.equal(state.mode, 'enabled');
  assert.equal(state.schema_version, 4);
  assert.equal(state.release_manifest_digest, RELEASE_DIGEST);
  assert.deepEqual(state.canary_receipt, receipt);
  assert.equal(assertLiveRollout(root, { releaseManifestDigest: RELEASE_DIGEST }), 'enabled');
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

test('live GoalSession commands fail closed while disabled and open only for this release', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'goal-condition-rollout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(root, { recursive: true });
  assert.throws(
    () => assertLiveRollout(root),
    (error) => error.code === 'ROLLOUT_LIVE_BLOCKED',
  );
  writeRolloutMode({
    path: join(root, 'rollout.json'), current: 'disabled', next: 'canary',
    changedAt: '2026-08-11T00:00:00.000Z',
    releaseManifestDigest: RELEASE_DIGEST,
  });
  assert.equal(assertLiveRollout(root, { releaseManifestDigest: RELEASE_DIGEST }), 'canary');
  assert.throws(
    () => assertLiveRollout(root, { releaseManifestDigest: '8'.repeat(64) }),
    (error) => error.code === 'ROLLOUT_RELEASE_MISMATCH',
  );
});

test('schema-v3 rollout states migrate once into the V2-only vocabulary', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'goal-condition-rollout-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const receipt = certifyRolloutCanary(certifiedCanaryExport(), {
    releaseManifestDigest: RELEASE_DIGEST,
  });
  const cases = [
    {
      before: { schema_version: 3, mode: 'shadow', changed_at: null, release_manifest_digest: null, canary_receipt: null },
      after: 'disabled',
    },
    {
      before: { schema_version: 3, mode: 'opt-in', changed_at: '2026-08-11T00:00:00.000Z', release_manifest_digest: null, canary_receipt: null },
      after: 'canary',
    },
    {
      before: { schema_version: 3, mode: 'default', changed_at: '2026-08-11T00:01:00.000Z', release_manifest_digest: RELEASE_DIGEST, canary_receipt: receipt },
      after: 'enabled',
    },
    {
      before: { schema_version: 3, mode: 'legacy-freeze', changed_at: '2026-08-11T00:02:00.000Z', release_manifest_digest: RELEASE_DIGEST, canary_receipt: receipt },
      after: 'enabled',
    },
  ];
  cases.forEach(({ before, after }, index) => {
    const path = join(root, `rollout-${index}.json`);
    writeFileSync(path, JSON.stringify(before), { mode: 0o600 });
    const migrated = ensureRolloutState(path, { releaseManifestDigest: RELEASE_DIGEST });
    assert.equal(migrated.schema_version, 4);
    assert.equal(migrated.mode, after);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), migrated);
    assert.deepEqual(ensureRolloutState(path, { releaseManifestDigest: RELEASE_DIGEST }), migrated);
  });
});

test('ambiguous legacy rollout state fails closed instead of being normalized', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'goal-condition-rollout-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'rollout.json');
  writeFileSync(path, JSON.stringify({
    schema_version: 3,
    mode: 'opt-in',
    changed_at: '2026-08-11T00:00:00.000Z',
    release_manifest_digest: RELEASE_DIGEST,
    canary_receipt: null,
  }), { mode: 0o600 });
  assert.throws(
    () => ensureRolloutState(path, { releaseManifestDigest: RELEASE_DIGEST }),
    (error) => error.code === 'ROLLOUT_STATE_INVALID',
  );
});
