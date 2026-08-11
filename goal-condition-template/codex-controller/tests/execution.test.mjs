import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { compileDraft, recordConfirmation } from '../src/compiler.mjs';
import { transitionSession } from '../src/domain.mjs';
import { prepareControlledAttempt, launchControlledAttempt } from '../src/execution.mjs';
import { openSessionStore } from '../src/store.mjs';
import { validDraft } from './helpers.mjs';

const roots = [];

async function fixture() {
  const root = await mkdtemp(join(process.cwd(), '.gc-execution-test-'));
  roots.push(root);
  const target = join(root, 'target');
  await mkdir(target);
  const draft = validDraft();
  draft.authority.target_roots = [target];
  draft.initial_design.active_boundary.target_roots = [target];
  draft.initial_design.conditions[0].verifier.cwd = target;
  const compiled = compileDraft(draft);
  const receipt = recordConfirmation({
    session: compiled.session,
    observed: {
      authorization_hash: compiled.session.authorization_hash,
      thread_id: 'controller-thread',
      message_ref: 'confirmation-message',
      source: 'codex-task',
      confirmed_at: '2026-08-11T00:00:00.000Z',
    },
  });
  const session = transitionSession(compiled.session, { type: 'AUTHORIZATION_CONFIRMED', receipt });
  const store = openSessionStore({ stateRoot: join(root, 'state'), targetRoots: [target] });
  store.create(session);
  return { root, target, store, session };
}

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('intent and exclusive root lease are durable before the live launcher is called', async () => {
  const { target, store, session } = await fixture();
  const events = [];
  const prepared = prepareControlledAttempt({
    store,
    sessionId: session.session_id,
    attemptId: 'attempt-0001',
    workspaceDigest: 'b'.repeat(64),
    runId: 'run-0001',
    now: '2026-08-11T00:00:00.000Z',
    expiresAt: '2026-08-11T01:00:00.000Z',
    nonce: '00112233445566778899aabbccddeeff',
    capabilityReport: { launchable: true },
  });
  assert.equal(store.readLaunchIntent('run-0001').attempt_id, 'attempt-0001');
  assert.equal(store.readRootLease(target).run_id, 'run-0001');
  assert.equal(store.read(session.session_id).attempts.length, 0);

  const launched = await launchControlledAttempt({
    store,
    prepared,
    launch: async () => {
      events.push('launch');
      assert.equal(store.readLaunchIntent('run-0001').status, 'pending');
      return { outcome: 'candidate', threadId: 'thread-1', candidate: { status: 'ready_for_postflight' } };
    },
    readback: async () => ({ available: true, thread_id: 'thread-1', turns: [{ id: 'turn-1' }] }),
    now: '2026-08-11T00:01:00.000Z',
  });
  assert.deepEqual(events, ['launch']);
  assert.equal(launched.session.attempts.length, 1);
  assert.equal(launched.session.attempts[0].status, 'Candidate');
  assert.equal(launched.session.status, 'Evaluating');
  store.close();
});

test('an ambiguous launch is reconciled without a second launcher call', async () => {
  const { store, session } = await fixture();
  let launches = 0;
  const prepared = prepareControlledAttempt({
    store, sessionId: session.session_id, attemptId: 'attempt-0001',
    workspaceDigest: 'b'.repeat(64), runId: 'run-0001',
    now: '2026-08-11T00:00:00.000Z', expiresAt: '2026-08-11T01:00:00.000Z',
    nonce: '00112233445566778899aabbccddeeff', capabilityReport: { launchable: true },
  });
  const result = await launchControlledAttempt({
    store,
    prepared,
    launch: async () => { launches += 1; throw new Error('connection lost after send'); },
    readback: async () => ({ available: false }),
    now: '2026-08-11T00:01:00.000Z',
  });
  assert.equal(launches, 1);
  assert.equal(result.disposition, 'reconciliation_required');
  assert.equal(store.read(session.session_id).status, 'ReconciliationRequired');
  assert.equal(store.readLaunchIntent('run-0001').status, 'ambiguous');
  store.close();
});
