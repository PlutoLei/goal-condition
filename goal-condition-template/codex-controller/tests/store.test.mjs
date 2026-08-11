import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { createGoalSession } from '../src/domain.mjs';
import { openSessionStore } from '../src/store.mjs';
import { validDraft } from './helpers.mjs';

const roots = [];

async function openTestStore(options = {}) {
  const stateRoot = await mkdtemp(join(process.cwd(), '.gc-store-test-'));
  roots.push(stateRoot);
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 7, 11, 0, 0, tick++)).toISOString();
  return {
    stateRoot,
    store: openSessionStore({ stateRoot, clock, ...options }),
  };
}

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('target-root leases are exclusive and expired owners require reconciliation', async () => {
  const root = await mkdtemp(join(process.cwd(), '.gc-store-lease-test-'));
  roots.push(root);
  const stateRoot = join(root, 'state');
  const target = join(root, 'target-root');
  await mkdir(target);
  let now = new Date('2026-08-11T00:00:00.000Z');
  const store = openSessionStore({ stateRoot, targetRoots: [target], clock: () => now });
  const lease = store.acquireRootLeases({
    roots: [target], sessionId: 'session-a', attemptId: 'attempt-a', runId: 'run-a',
    ownerToken: 'owner-a', expiresAt: '2026-08-11T00:01:00.000Z', writable: true,
  });
  assert.equal(lease.length, 1);
  assert.throws(
    () => store.acquireRootLeases({
      roots: [target], sessionId: 'session-b', attemptId: 'attempt-b', runId: 'run-b',
      ownerToken: 'owner-b', expiresAt: '2026-08-11T00:01:00.000Z', writable: true,
    }),
    (error) => error.code === 'TARGET_ROOT_LEASE_CONFLICT',
  );
  now = new Date('2026-08-11T00:02:00.000Z');
  assert.throws(
    () => store.acquireRootLeases({
      roots: [target], sessionId: 'session-b', attemptId: 'attempt-b', runId: 'run-b',
      ownerToken: 'owner-b', expiresAt: '2026-08-11T00:03:00.000Z', writable: true,
    }),
    (error) => error.code === 'TARGET_ROOT_LEASE_RECONCILIATION_REQUIRED',
  );
  assert.equal(store.readRootLease(target, { runId: 'run-a' }).status, 'reconciliation_required');
  store.close();
});

test('controller state rejects a symlinked ancestor that resolves inside an executor target', async () => {
  const root = await mkdtemp(join(process.cwd(), '.gc-store-symlink-state-test-'));
  roots.push(root);
  const target = join(root, 'target');
  const alias = join(root, 'alias');
  await mkdir(target);
  await symlink(target, alias, 'dir');
  assert.throws(
    () => openSessionStore({ stateRoot: join(alias, 'controller-state'), targetRoots: [target] }),
    (error) => ['STATE_ROOT_SYMLINKED', 'STATE_ROOT_OVERLAPS_TARGET'].includes(error.code),
  );
});

test('read-only leases can share a target root while writable leases remain exclusive', async () => {
  const root = await mkdtemp(join(process.cwd(), '.gc-store-read-lease-test-'));
  roots.push(root);
  const target = join(root, 'target-root');
  await mkdir(target);
  const store = openSessionStore({
    stateRoot: join(root, 'state'),
    targetRoots: [target],
    clock: () => new Date('2026-08-11T00:00:00.000Z'),
  });
  for (const suffix of ['a', 'b']) {
    store.acquireRootLeases({
      roots: [target], sessionId: `session-${suffix}`, attemptId: `attempt-${suffix}`,
      runId: `run-${suffix}`, ownerToken: `owner-${suffix}`,
      expiresAt: '2026-08-11T00:01:00.000Z', writable: false,
    });
  }
  assert.equal(store.readRootLease(target, { runId: 'run-a' }).writable, false);
  assert.equal(store.readRootLease(target, { runId: 'run-b' }).writable, false);
  assert.throws(
    () => store.acquireRootLeases({
      roots: [target], sessionId: 'session-c', attemptId: 'attempt-c', runId: 'run-c',
      ownerToken: 'owner-c', expiresAt: '2026-08-11T00:01:00.000Z', writable: true,
    }),
    (error) => error.code === 'TARGET_ROOT_LEASE_CONFLICT',
  );
  store.close();
});

test('launch intent claim is a one-way pending to dispatching CAS and enforces expiry', async () => {
  const root = await mkdtemp(join(process.cwd(), '.gc-store-intent-test-'));
  roots.push(root);
  const target = join(root, 'target-root');
  await mkdir(target);
  let now = new Date('2026-08-11T00:00:00.000Z');
  const store = openSessionStore({ stateRoot: join(root, 'state'), targetRoots: [target], clock: () => now });
  const session = store.create(createGoalSession(validDraft()));
  const intent = {
    intent_version: 1, session_id: session.session_id, attempt_id: 'attempt-a', run_id: 'run-a',
    expires_at: '2026-08-11T00:01:00.000Z', payload: 'opaque-for-store',
  };
  store.persistLaunchIntent({ intent, roots: [target], ownerToken: 'owner-a' });
  assert.equal(store.claimLaunchIntent({ runId: 'run-a' }).status, 'dispatching');
  assert.throws(
    () => store.claimLaunchIntent({ runId: 'run-a' }),
    (error) => error.code === 'LAUNCH_INTENT_NOT_PENDING',
  );
  assert.throws(
    () => store.updateLaunchIntentStatus({ runId: 'run-a', status: 'pending' }),
    (error) => error.code === 'LAUNCH_INTENT_TRANSITION_INVALID',
  );
  store.updateLaunchIntentStatus({ runId: 'run-a', status: 'closed' });
  store.releaseRootLeases({ runId: 'run-a', ownerToken: 'owner-a' });

  const expired = { ...intent, run_id: 'run-b', attempt_id: 'attempt-b' };
  store.persistLaunchIntent({ intent: expired, roots: [target], ownerToken: 'owner-b' });
  now = new Date('2026-08-11T00:02:00.000Z');
  assert.throws(
    () => store.claimLaunchIntent({ runId: 'run-b' }),
    (error) => error.code === 'LAUNCH_INTENT_EXPIRED',
  );
  store.close();
});

test('compareAndCommit atomically advances one revision and rejects stale writers', async () => {
  const { store } = await openTestStore();
  const session = store.create(createGoalSession(validDraft()));
  const next = { ...session, status: 'AwaitingConfirmation' };
  assert.equal(store.compareAndCommit({
    sessionId: session.session_id,
    expectedRevision: 0,
    eventType: 'DRAFT_COMPILED',
    nextState: next,
    blobs: [],
  }).revision, 1);
  assert.throws(() => store.compareAndCommit({
    sessionId: session.session_id,
    expectedRevision: 0,
    eventType: 'STALE_WRITE',
    nextState: next,
    blobs: [],
  }), (error) => error.code === 'SESSION_REVISION_CONFLICT');
  store.close();
});

test('event hashes form a chain and blob corruption fails closed', async () => {
  const { stateRoot, store } = await openTestStore();
  const session = store.create(createGoalSession(validDraft()));
  const committed = store.compareAndCommit({
    sessionId: session.session_id,
    expectedRevision: 0,
    eventType: 'DESIGN_RECORDED',
    nextState: { ...session, status: 'AwaitingConfirmation' },
    blobs: [{ kind: 'context-package', bytes: Buffer.from('bound context', 'utf8') }],
  });
  const exported = store.exportSession(session.session_id);
  assert.equal(exported.session.revision, 1);
  assert.equal(exported.events.length, 2);
  assert.equal(exported.events[1].previous_event_hash, exported.events[0].event_hash);
  assert.equal(exported.blobs.length, 1);

  const [blob] = exported.blobs;
  const blobPath = join(stateRoot, 'blobs', 'sha256', blob.hash.slice(0, 2), blob.hash);
  await writeFile(blobPath, 'corrupt bytes', { mode: 0o600 });
  assert.throws(
    () => store.read(committed.session_id),
    (error) => error.code === 'STATE_INTEGRITY_FAILURE',
  );
  store.close();
});

test('state paths and persisted controller files enforce isolation and modes', async () => {
  const { stateRoot, store } = await openTestStore();
  store.create(createGoalSession(validDraft()));
  assert.equal((await stat(stateRoot)).mode & 0o777, 0o700);
  for (const file of ['sessions.db', 'controller.key', 'controller.meta.json']) {
    assert.equal((await stat(join(stateRoot, file))).mode & 0o777, 0o600);
  }
  store.close();

  assert.throws(
    () => openSessionStore({ stateRoot: '/work/project/.goal-condition', targetRoots: ['/work/project'] }),
    (error) => error.code === 'STATE_ROOT_OVERLAPS_TARGET',
  );
  assert.throws(
    () => openSessionStore({ stateRoot: '/tmp/goal-condition-state', targetRoots: ['/work/project'] }),
    (error) => error.code === 'STATE_ROOT_TEMPORARY',
  );
});

test('a crash after blob publication leaves no committed event and orphan blobs are tolerated', async () => {
  const { stateRoot, store } = await openTestStore();
  const session = store.create(createGoalSession(validDraft()));
  store.close();

  const child = spawnSync(
    process.execPath,
    [new URL('./store-crash-child.mjs', import.meta.url).pathname, stateRoot, session.session_id],
    { encoding: 'utf8' },
  );
  assert.equal(child.signal, 'SIGKILL', child.stderr);

  const reopened = openSessionStore({ stateRoot });
  assert.equal(reopened.read(session.session_id).revision, 0);
  assert.equal(reopened.exportSession(session.session_id).events.length, 1);
  assert.equal(reopened.exportSession(session.session_id).blobs.length, 0);
  reopened.close();
});

test('getBlob verifies registered content and database mode repairs fail closed state', async () => {
  const { stateRoot, store } = await openTestStore();
  const descriptor = store.putBlob({ kind: 'projection-proof', bytes: Buffer.from('proof', 'utf8') });
  assert.equal(store.getBlob(descriptor.hash).toString('utf8'), 'proof');
  store.close();

  await chmod(join(stateRoot, 'sessions.db'), 0o644);
  const reopened = openSessionStore({ stateRoot });
  assert.equal((await stat(join(stateRoot, 'sessions.db'))).mode & 0o777, 0o600);
  reopened.close();
  assert.equal((await readFile(join(stateRoot, 'controller.key'))).byteLength, 32);
});
