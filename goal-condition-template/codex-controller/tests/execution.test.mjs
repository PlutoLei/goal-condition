import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { compileDraft, recordConfirmation } from '../src/compiler.mjs';
import { transitionSession } from '../src/domain.mjs';
import {
  prepareControlledAttempt as prepareAttempt,
  launchControlledAttempt as launchAttempt,
} from '../src/execution.mjs';
import { openSessionStore } from '../src/store.mjs';
import { validCompilerInput } from './helpers.mjs';

const roots = [];
const RELEASE_DIGEST = '9'.repeat(64);
const TURN_INPUT_HASH = '7'.repeat(64);

function prepareControlledAttempt(options) {
  return prepareAttempt({ ...options, controllerReleaseDigest: RELEASE_DIGEST });
}

function launchControlledAttempt(options) {
  return launchAttempt({ ...options, controllerReleaseDigest: RELEASE_DIGEST });
}

async function fixture() {
  const root = await mkdtemp(join(process.cwd(), '.gc-execution-test-'));
  roots.push(root);
  const target = join(root, 'target');
  await mkdir(target);
  const draft = validCompilerInput();
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
    expiresAt: '2099-08-11T01:00:00.000Z',
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
      assert.equal(store.readLaunchIntent('run-0001').status, 'dispatching');
      assert.equal(store.read(session.session_id).status, 'Dispatching');
      return {
        outcome: 'candidate', threadId: 'thread-1', turnId: 'turn-1', initialTurnIds: [],
        turnInputSha256: TURN_INPUT_HASH,
        candidate: { status: 'ready_for_postflight', remaining_work: false },
      };
    },
    readback: async () => ({
      available: true, thread_id: 'thread-1',
      turns: [{ id: 'turn-1', input_sha256: TURN_INPUT_HASH }],
    }),
    now: '2026-08-11T00:01:00.000Z',
  });
  assert.deepEqual(events, ['launch']);
  assert.equal(launched.session.attempts.length, 1);
  assert.equal(launched.session.attempts[0].status, 'Candidate');
  assert.deepEqual(launched.receipt.authorized_turn_ids, ['turn-1']);
  assert.equal(launched.session.status, 'Evaluating');
  store.close();
});

test('a creation receipt won inside the store returns the original run and its real status', async () => {
  const { store, session } = await fixture();
  const creationRequest = {
    kind: 'run',
    scopeId: session.session_id,
    requestKey: '1234567890abcdef1234567890abcdef',
    requestHash: '8'.repeat(64),
  };
  const common = {
    store,
    sessionId: session.session_id,
    attemptId: 'attempt-concurrent-recovery',
    workspaceDigest: 'b'.repeat(64),
    expiresAt: '2099-08-11T01:00:00.000Z',
    nonce: creationRequest.requestKey,
    capabilityReport: { launchable: true },
    creationRequest,
  };
  const first = prepareControlledAttempt({ ...common, runId: 'run-concurrent-first' });
  assert.equal(first.recovered, false);
  assert.equal(first.intent_status, 'pending');

  store.updateLaunchIntentStatus({ runId: first.run_id, status: 'dispatching' });
  const recovered = prepareControlledAttempt({ ...common, runId: 'run-concurrent-loser' });
  assert.equal(recovered.run_id, first.run_id);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.intent_status, 'dispatching');
  assert.equal(recovered.projection, null);
  assert.equal(recovered.runtime_prompt, null);
  store.close();
});

test('a fresh-thread 0-to-1 fence binds the persisted turn when start response identity drifts', async () => {
  const { store, session } = await fixture();
  const prepared = prepareControlledAttempt({
    store, sessionId: session.session_id, attemptId: 'attempt-id-drift',
    workspaceDigest: 'b'.repeat(64), runId: 'run-id-drift',
    expiresAt: '2099-08-11T01:00:00.000Z', nonce: '00112233445566778899aabbccddeeff',
    capabilityReport: { launchable: true },
  });
  const result = await launchControlledAttempt({
    store,
    prepared,
    launch: async () => ({
      outcome: 'candidate', threadId: 'thread-1',
      turnId: 'turn-start-response-v7', initialTurnIds: [],
      turnInputSha256: TURN_INPUT_HASH,
      candidate: { status: 'ready_for_postflight', remaining_work: false },
    }),
    readback: async () => ({
      available: true, thread_id: 'thread-1',
      turns: [{ id: 'turn-persisted-v4', input_sha256: TURN_INPUT_HASH }],
    }),
    now: '2026-08-11T00:01:00.000Z',
  });
  assert.equal(result.disposition, 'candidate');
  assert.equal(result.receipt.receipt_version, 2);
  assert.equal(result.receipt.turn_start_response_id, 'turn-start-response-v7');
  assert.equal(result.receipt.turn_id, 'turn-persisted-v4');
  assert.equal(result.receipt.turn_input_sha256, TURN_INPUT_HASH);
  assert.deepEqual(result.receipt.authorized_turn_ids, ['turn-persisted-v4']);
  store.close();
});

test('a lone persisted turn with different input bytes is a control-plane bypass', async () => {
  const { store, session } = await fixture();
  const prepared = prepareControlledAttempt({
    store, sessionId: session.session_id, attemptId: 'attempt-input-mismatch',
    workspaceDigest: 'b'.repeat(64), runId: 'run-input-mismatch',
    expiresAt: '2099-08-11T01:00:00.000Z', nonce: '00112233445566778899aabbccddeeff',
    capabilityReport: { launchable: true },
  });
  const result = await launchControlledAttempt({
    store,
    prepared,
    launch: async () => ({
      outcome: 'candidate', threadId: 'thread-1',
      turnId: 'turn-start-response-v7', initialTurnIds: [],
      turnInputSha256: TURN_INPUT_HASH,
      candidate: { status: 'ready_for_postflight', remaining_work: false },
    }),
    readback: async () => ({
      available: true, thread_id: 'thread-1',
      turns: [{ id: 'turn-external', input_sha256: '8'.repeat(64) }],
    }),
    now: '2026-08-11T00:01:00.000Z',
  });
  assert.equal(result.disposition, 'control_plane_bypass');
  assert.equal(result.session.status, 'ReconciliationRequired');
  assert.equal(result.receipt, undefined);
  store.close();
});

test('more than one persisted turn before receipt is a control-plane bypass', async () => {
  const { store, session } = await fixture();
  const prepared = prepareControlledAttempt({
    store, sessionId: session.session_id, attemptId: 'attempt-injected',
    workspaceDigest: 'b'.repeat(64), runId: 'run-injected',
    expiresAt: '2099-08-11T01:00:00.000Z', nonce: '00112233445566778899aabbccddeeff',
    capabilityReport: { launchable: true },
  });
  const result = await launchControlledAttempt({
    store,
    prepared,
    launch: async () => ({
      outcome: 'candidate', threadId: 'thread-1', turnId: 'turn-authorized', initialTurnIds: [],
      turnInputSha256: TURN_INPUT_HASH,
      candidate: { status: 'ready_for_postflight', remaining_work: false },
    }),
    readback: async () => ({
      available: true,
      thread_id: 'thread-1',
      turns: [
        { id: 'turn-injected-before-receipt', input_sha256: '8'.repeat(64) },
        { id: 'turn-authorized', input_sha256: TURN_INPUT_HASH },
      ],
    }),
    now: '2026-08-11T00:01:00.000Z',
  });
  assert.equal(result.disposition, 'control_plane_bypass');
  assert.equal(result.session.status, 'ReconciliationRequired');
  assert.equal(result.receipt, undefined);
  store.close();
});

test('a dispatching intent is never replayed after the crash window', async () => {
  const { store, session } = await fixture();
  const prepared = prepareControlledAttempt({
    store, sessionId: session.session_id, attemptId: 'attempt-0001',
    workspaceDigest: 'b'.repeat(64), runId: 'run-0001',
    expiresAt: '2099-08-11T01:00:00.000Z', nonce: '00112233445566778899aabbccddeeff',
    capabilityReport: { launchable: true },
  });
  store.claimLaunchIntent({ runId: prepared.run_id });
  let launches = 0;
  await assert.rejects(
    () => launchControlledAttempt({
      store,
      prepared,
      launch: async () => { launches += 1; },
      readback: async () => ({ available: true, turns: [] }),
      now: '2026-08-11T00:01:00.000Z',
    }),
    (error) => error.code === 'LAUNCH_INTENT_NOT_PENDING',
  );
  assert.equal(launches, 0);
  store.close();
});

test('launch fails before dispatch when the controller release changed after prepare', async () => {
  const { store, session } = await fixture();
  const prepared = prepareControlledAttempt({
    store, sessionId: session.session_id, attemptId: 'attempt-release-change',
    workspaceDigest: 'b'.repeat(64), runId: 'run-release-change',
    expiresAt: '2099-08-11T01:00:00.000Z', nonce: '00112233445566778899aabbccddeeff',
    capabilityReport: { launchable: true },
  });
  let launches = 0;
  await assert.rejects(
    () => launchAttempt({
      store,
      prepared,
      controllerReleaseDigest: '8'.repeat(64),
      launch: async () => { launches += 1; },
      readback: async () => ({ available: false }),
      now: '2026-08-11T00:01:00.000Z',
    }),
    (error) => error.code === 'CONTROLLER_RELEASE_CHANGED',
  );
  assert.equal(launches, 0);
  assert.equal(store.readLaunchIntent(prepared.run_id).status, 'pending');
  assert.equal(store.read(session.session_id).status, 'Ready');
  store.close();
});

test('intent claim and Session Dispatching transition commit or roll back together', async () => {
  const { store, session } = await fixture();
  const prepared = prepareControlledAttempt({
    store, sessionId: session.session_id, attemptId: 'attempt-atomic',
    workspaceDigest: 'b'.repeat(64), runId: 'run-atomic',
    expiresAt: '2099-08-11T01:00:00.000Z', nonce: '00112233445566778899aabbccddeeff',
    capabilityReport: { launchable: true },
  });
  store.faultInjector = (point) => {
    if (point === 'after_atomic_dispatch_update') throw new Error('simulated dispatch transaction crash');
  };
  let launches = 0;
  await assert.rejects(
    () => launchControlledAttempt({
      store,
      prepared,
      launch: async () => { launches += 1; },
      readback: async () => ({ available: false }),
      now: '2026-08-11T00:01:00.000Z',
    }),
    /simulated dispatch transaction crash/,
  );
  assert.equal(launches, 0);
  assert.equal(store.readLaunchIntent(prepared.run_id).status, 'pending');
  assert.equal(store.read(session.session_id).status, 'Ready');
  store.close();
});

test('launch rejects a target root whose physical inode changed after prepare', async () => {
  const { target, store, session } = await fixture();
  const prepared = prepareControlledAttempt({
    store, sessionId: session.session_id, attemptId: 'attempt-root-swap',
    workspaceDigest: 'b'.repeat(64), runId: 'run-root-swap',
    expiresAt: '2099-08-11T01:00:00.000Z', nonce: '00112233445566778899aabbccddeeff',
    capabilityReport: { launchable: true },
  });
  await rename(target, `${target}-original`);
  await mkdir(target);
  let launches = 0;
  await assert.rejects(
    () => launchControlledAttempt({
      store,
      prepared,
      launch: async () => { launches += 1; },
      readback: async () => ({ available: false }),
      now: '2026-08-11T00:01:00.000Z',
    }),
    (error) => error.code === 'TARGET_ROOT_IDENTITY_CHANGED',
  );
  assert.equal(launches, 0);
  assert.equal(store.readLaunchIntent(prepared.run_id).status, 'pending');
  assert.equal(store.read(session.session_id).status, 'Ready');
  await rm(target, { recursive: true, force: true });
  await rename(`${target}-original`, target);
  store.close();
});

test('launch completion cannot overwrite a concurrent controller revision', async () => {
  const { store, session } = await fixture();
  const prepared = prepareControlledAttempt({
    store, sessionId: session.session_id, attemptId: 'attempt-0001',
    workspaceDigest: 'b'.repeat(64), runId: 'run-0001',
    expiresAt: '2099-08-11T01:00:00.000Z', nonce: '00112233445566778899aabbccddeeff',
    capabilityReport: { launchable: true },
  });
  await assert.rejects(
    () => launchControlledAttempt({
      store,
      prepared,
      launch: async () => {
        const dispatching = store.read(session.session_id);
        store.compareAndCommit({
          sessionId: dispatching.session_id,
          expectedRevision: dispatching.revision,
          eventType: 'CONCURRENT_CONTROLLER_WRITE',
          nextState: { ...dispatching, status: 'Blocked' },
          blobs: [],
        });
        return {
          outcome: 'candidate', threadId: 'thread-1', turnId: 'turn-1', initialTurnIds: [],
          turnInputSha256: TURN_INPUT_HASH,
          candidate: { status: 'ready_for_postflight', remaining_work: false },
        };
      },
      readback: async () => ({
        available: true, thread_id: 'thread-1',
        turns: [{ id: 'turn-1', input_sha256: TURN_INPUT_HASH }],
      }),
      now: '2026-08-11T00:01:00.000Z',
    }),
    (error) => error.code === 'SESSION_REVISION_CONFLICT',
  );
  assert.equal(store.read(session.session_id).status, 'Blocked');
  store.close();
});

test('an ambiguous launch is reconciled without a second launcher call', async () => {
  const { store, session } = await fixture();
  let launches = 0;
  const prepared = prepareControlledAttempt({
    store, sessionId: session.session_id, attemptId: 'attempt-0001',
    workspaceDigest: 'b'.repeat(64), runId: 'run-0001',
    now: '2026-08-11T00:00:00.000Z', expiresAt: '2099-08-11T01:00:00.000Z',
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

test('a native terminal report rejects the Attempt and blocks the Session', async () => {
  const { store, session } = await fixture();
  const prepared = prepareControlledAttempt({
    store, sessionId: session.session_id, attemptId: 'attempt-terminal',
    workspaceDigest: 'b'.repeat(64), runId: 'run-terminal',
    expiresAt: '2099-08-11T01:00:00.000Z', nonce: '00112233445566778899aabbccddeeff',
    capabilityReport: { launchable: true },
  });
  const result = await launchControlledAttempt({
    store,
    prepared,
    launch: async () => ({
      outcome: 'terminal_report', threadId: 'thread-1', turnId: 'turn-1', initialTurnIds: [],
      turnInputSha256: TURN_INPUT_HASH,
      reasons: ['blocked'],
    }),
    readback: async () => ({
      available: true, thread_id: 'thread-1',
      turns: [{ id: 'turn-1', input_sha256: TURN_INPUT_HASH }],
    }),
    now: '2026-08-11T00:01:00.000Z',
  });
  assert.equal(result.session.status, 'Blocked');
  assert.equal(result.session.attempts[0].status, 'Rejected');
  assert.equal(result.session.attempts[0].completion_level, 'candidate');
  store.close();
});
