import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLAUDE_CANARY_CONDITIONS,
  assertClaudeCertified,
  evaluateClaudeCapability,
  publishClaudeCapabilityState,
  readClaudeCapabilityState,
} from '../scripts/lib/claude-capability.mjs';

const H = {
  runtime: '1'.repeat(64), contract: '2'.repeat(64), baseline: '3'.repeat(64),
  evidence: '4'.repeat(64), candidate: '5'.repeat(64), postflight: '6'.repeat(64),
};

const checkoutSource = Object.freeze({
  kind: 'git_checkout', root_realpath: '/controller/source', commit: 'a'.repeat(40),
});
const releaseSource = Object.freeze({
  kind: 'immutable_release', root_realpath: '/controller/release', manifest_digest: 'b'.repeat(64),
});
const environment = Object.freeze({
  cli_version: '2.1.228', os: 'darwin', arch: 'arm64',
  auth_mode: 'claude_ai', auth_context_id: 'canary-primary',
});

function receipt(overrides = {}) {
  return {
    schema_version: 1,
    source: checkoutSource,
    runtime_surface_digest: H.runtime,
    environment,
    canary_contract_hash: H.contract,
    baseline_digest: H.baseline,
    run_identity: { run_id: 'cert-run-1', session_id: '11111111-1111-4111-8111-111111111111' },
    conditions: Object.fromEntries(CLAUDE_CANARY_CONDITIONS.map((id) => [id, true])),
    evidence_aggregate_hash: H.evidence,
    candidate_result_hash: H.candidate,
    postflight_report_hash: H.postflight,
    certified_at: '2026-08-13T08:00:00.000Z',
    ...overrides,
  };
}

function certifiedState(overrides = {}) {
  return {
    schema_version: 1,
    mode: 'certified',
    changed_at: '2026-08-13T08:00:00.000Z',
    active_source: checkoutSource,
    runtime_surface_digest: H.runtime,
    environment,
    canary_receipt: receipt(),
    ...overrides,
  };
}

function evaluate(state = certifiedState(), overrides = {}) {
  return evaluateClaudeCapability({
    state, source: checkoutSource, runtimeSurfaceDigest: H.runtime, environment, ...overrides,
  });
}

test('exact matching certified state evaluates certified', () => {
  assert.deepEqual(evaluate(), { mode: 'certified', reasons: [] });
  assert.doesNotThrow(() => assertClaudeCertified({
    state: certifiedState(), source: checkoutSource,
    runtimeSurfaceDigest: H.runtime, environment,
  }));
});

test('missing, candidate, unknown-field, and malformed-receipt states evaluate Candidate', () => {
  const extra = certifiedState({ extra: true });
  const candidate = certifiedState({ mode: 'candidate', canary_receipt: null });
  const incompleteConditions = receipt({
    conditions: { ...receipt().conditions, 'baseline-preserved': false },
  });
  assert.equal(evaluateClaudeCapability({
    state: undefined, source: checkoutSource, runtimeSurfaceDigest: H.runtime, environment,
  }).mode, 'candidate');
  for (const state of [candidate, extra, certifiedState({ canary_receipt: incompleteConditions })]) {
    const verdict = evaluate(state);
    assert.equal(verdict.mode, 'candidate');
    assert.ok(verdict.reasons.length > 0);
  }
});

test('runtime, CLI, OS, arch, auth mode, and opaque auth context drift each invalidate certification', () => {
  const cases = [
    { runtimeSurfaceDigest: '9'.repeat(64) },
    { environment: { ...environment, cli_version: '2.1.229' } },
    { environment: { ...environment, os: 'linux' } },
    { environment: { ...environment, arch: 'x64' } },
    { environment: { ...environment, auth_mode: 'api_key' } },
    { environment: { ...environment, auth_context_id: 'canary-secondary' } },
  ];
  for (const current of cases) assert.equal(evaluate(certifiedState(), current).mode, 'candidate');
  assert.equal(evaluate(certifiedState(), {
    environment: { ...environment, auth_mode: 'oauth-email' },
  }).mode, 'candidate');
});

test('source kind, root, checkout commit, and release manifest drift each invalidate certification', () => {
  assert.equal(evaluate(certifiedState(), { source: releaseSource }).mode, 'candidate');
  assert.equal(evaluate(certifiedState(), {
    source: { ...checkoutSource, root_realpath: '/controller/other' },
  }).mode, 'candidate');
  assert.equal(evaluate(certifiedState(), {
    source: { ...checkoutSource, commit: 'c'.repeat(40) },
  }).mode, 'candidate');

  const releaseState = certifiedState({
    active_source: releaseSource,
    canary_receipt: receipt({ source: releaseSource }),
  });
  assert.equal(evaluateClaudeCapability({
    state: releaseState,
    source: { ...releaseSource, manifest_digest: 'd'.repeat(64) },
    runtimeSurfaceDigest: H.runtime,
    environment,
  }).mode, 'candidate');
});

test('read validates no-follow regular-file shape and exact 0600/0700 modes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gc-claude-capability-read-'));
  const dir = join(root, 'runtime-certifications');
  const path = join(dir, 'claude.json');
  await mkdir(dir, { mode: 0o700 });
  await writeFile(path, JSON.stringify(certifiedState()), { mode: 0o600 });

  const read = await readClaudeCapabilityState(path);
  assert.equal(read.ok, true);
  assert.deepEqual(read.state, certifiedState());

  await chmod(path, 0o644);
  assert.equal((await readClaudeCapabilityState(path)).ok, false);
  await chmod(path, 0o600);
  await chmod(dir, 0o755);
  assert.equal((await readClaudeCapabilityState(path)).ok, false);

  const unsupported = await readClaudeCapabilityState(join(root, 'missing.json'), undefined);
  assert.equal(unsupported.missing, true);
  const unsafe = await readClaudeCapabilityState(path, null);
  assert.equal(unsafe.ok, false);
});

test('publish is atomic, private, read-back verified, and preserves old state on pre-rename failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gc-claude-capability-publish-'));
  const path = join(root, 'runtime-certifications', 'claude.json');
  const initial = certifiedState();
  await publishClaudeCapabilityState(path, initial);
  assert.equal((await lstat(join(root, 'runtime-certifications'))).mode & 0o7777, 0o700);
  assert.equal((await lstat(path)).mode & 0o7777, 0o600);
  assert.equal((await readClaudeCapabilityState(path)).ok, true);

  const replacement = certifiedState({ changed_at: '2026-08-13T09:00:00.000Z' });
  await assert.rejects(
    () => publishClaudeCapabilityState(path, replacement, {
      beforeRename: async () => { throw new Error('fault before rename'); },
    }),
    /fault before rename/,
  );
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), initial);
  assert.equal((await readClaudeCapabilityState(path, constants.O_NOFOLLOW)).ok, true);
});
