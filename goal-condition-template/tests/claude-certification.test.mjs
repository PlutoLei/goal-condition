import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClaudeCertificationReceipt,
  classifyClaudeCanaryBlocker,
  compileClaudeCertificationContract,
  exactSentinelReadDenial,
  interpretClaudeControlReport,
  runClaudeCertification,
} from '../scripts/lib/claude-certification.mjs';
import { CLAUDE_CANARY_CONDITIONS } from '../scripts/lib/claude-capability.mjs';

const source = Object.freeze({
  kind: 'git_checkout', root_realpath: '/opt/controller/source', commit: 'a'.repeat(40),
});
const environment = Object.freeze({
  cli_version: '2.1.228', os: 'darwin', arch: 'arm64',
  auth_mode: 'claude_ai', auth_context_id: 'cert-primary',
});
const runtimeSurfaceDigest = '1'.repeat(64);
const sentinelSha256 = '2'.repeat(64);
const baselineDigest = '3'.repeat(64);

function compile(overrides = {}) {
  return compileClaudeCertificationContract({
    source,
    runtimeSurfaceDigest,
    targetRoot: '/opt/controller/canary-target-a',
    stateRoot: '/opt/controller/canary-state-a',
    authMode: environment.auth_mode,
    authContextId: environment.auth_context_id,
    sentinelSha256,
    maxTurns: 5,
    ...overrides,
  });
}

function allGreenConditions() {
  return Object.fromEntries(CLAUDE_CANARY_CONDITIONS.map((id) => [id, true]));
}

function receiptEvidence(overrides = {}) {
  return {
    source,
    runtimeSurfaceDigest,
    environment,
    contractHash: compile().hash,
    baselineDigest,
    runIdentity: { run_id: 'cert-run-1', session_id: '11111111-1111-4111-8111-111111111111' },
    conditions: allGreenConditions(),
    evidence: Object.fromEntries(CLAUDE_CANARY_CONDITIONS.map((id) => [id, { ok: true }])),
    candidateResult: { subtype: 'success', is_error: false, terminal_reason: 'completed', permission_denials: [] },
    postflightReport: { ok: true, violations: [] },
    certifiedAt: '2026-08-13T08:00:00.000Z',
    ...overrides,
  };
}

test('fixed compiler binds every disposable path and sentinel into canonical bytes/hash and full preview', () => {
  const first = compile();
  assert.deepEqual(JSON.parse(first.canonicalBytes), first.artifact);
  assert.ok(first.preview.includes(first.canonicalBytes));
  assert.ok(first.preview.includes(`SHA-256: ${first.hash}`));
  assert.ok(first.preview.includes('auth_context_id is operator-managed'));

  for (const changed of [
    compile({ targetRoot: '/opt/controller/canary-target-b' }),
    compile({ stateRoot: '/opt/controller/canary-state-b' }),
    compile({ sentinelSha256: '9'.repeat(64) }),
    compile({ source: { ...source, root_realpath: '/opt/controller/source-b' } }),
    compile({ source: { ...source, commit: 'b'.repeat(40) } }),
    compile({ runtimeSurfaceDigest: '8'.repeat(64) }),
    compile({ authMode: 'api_key' }),
    compile({ authContextId: 'cert-secondary' }),
  ]) {
    assert.notEqual(changed.canonicalBytes, first.canonicalBytes);
    assert.notEqual(changed.hash, first.hash);
  }
});

test('stale confirmation and arbitrary contract drift fail before baseline or executor work', async () => {
  const compiled = compile();
  let baselineCalls = 0;
  let executorCalls = 0;
  const dependencies = {
    captureBaseline: async () => { baselineCalls += 1; },
    runControlLane: async () => { executorCalls += 1; },
    runAdapterLane: async () => { executorCalls += 1; },
  };
  await assert.rejects(
    () => runClaudeCertification({
      compiled, confirmedHash: 'f'.repeat(64), source, runtimeSurfaceDigest, environment, dependencies,
    }),
    (error) => error.code === 'CLAUDE_CERTIFICATION_CONFIRMATION_MISMATCH',
  );
  await assert.rejects(
    () => runClaudeCertification({
      compiled: { ...compiled, contract: { ...compiled.contract, objective: 'arbitrary contract' } },
      confirmedHash: compiled.hash, source, runtimeSurfaceDigest, environment, dependencies,
    }),
    (error) => error.code === 'CLAUDE_CERTIFICATION_PROFILE_INVALID',
  );
  assert.equal(baselineCalls, 0);
  assert.equal(executorCalls, 0);
});

test('receipt is emitted only when all five fixed controller-owned conditions pass', () => {
  const complete = buildClaudeCertificationReceipt(receiptEvidence());
  assert.deepEqual(Object.keys(complete.conditions).sort(), [...CLAUDE_CANARY_CONDITIONS].sort());
  for (const id of CLAUDE_CANARY_CONDITIONS) {
    assert.throws(
      () => buildClaudeCertificationReceipt(receiptEvidence({
        conditions: { ...allGreenConditions(), [id]: false },
      })),
      (error) => error.code === 'CLAUDE_CERTIFICATION_INCOMPLETE',
      id,
    );
  }
});

test('quota, subscription, session, network, and provider failures classify blocked', () => {
  for (const result of [
    { status: 429 },
    { code: 'rate_limit_error' },
    { code: 'ECONNRESET' },
    { message: 'subscription or session limit reached' },
    { provider_error: true },
  ]) assert.equal(classifyClaudeCanaryBlocker(result), 'blocked');
  assert.equal(classifyClaudeCanaryBlocker({ outcome: 'candidate_rejected' }), 'candidate_rejected');
  assert.equal(classifyClaudeCanaryBlocker(new TypeError('controller bug')), 'controller_error');
  assert.equal(interpretClaudeControlReport({
    api_error_status: 429, permission_denials: [], errors: ['rate limit'],
  }, compile()).outcome, 'blocked');
});

test('ambient control is green only for a Read denial on the exact sentinel input', () => {
  const compiled = compile();
  const exact = {
    permission_denials: [{
      tool_name: 'Read', tool_input: { file_path: '/opt/controller/canary-target-a/sentinel.input' },
    }],
  };
  assert.equal(exactSentinelReadDenial(exact, compiled), true);
  for (const report of [
    { permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'cat sentinel.input' } }] },
    { permission_denials: [{ tool_name: 'Read', tool_input: { file_path: '/opt/controller/other' } }] },
    { permission_denials: [{ tool_name: 'Read', tool_input: {} }] },
  ]) assert.equal(exactSentinelReadDenial(report, compiled), false);
});

test('pre-existing sentinel output rejects before baseline or executor work', async () => {
  const compiled = compile();
  let baselineCalls = 0;
  let executorCalls = 0;
  const result = await runClaudeCertification({
    compiled, confirmedHash: compiled.hash, source, runtimeSurfaceDigest, environment,
    dependencies: {
      assertSentinelAbsent: async () => ({ ok: false }),
      captureBaseline: async () => { baselineCalls += 1; },
      runControlLane: async () => { executorCalls += 1; },
      runAdapterLane: async () => { executorCalls += 1; },
    },
  });
  assert.equal(result.outcome, 'candidate_rejected');
  assert.equal(baselineCalls, 0);
  assert.equal(executorCalls, 0);
});

test('blocked provider result preserves an existing receipt and is never candidate_rejected', async () => {
  const compiled = compile();
  let publications = 0;
  const result = await runClaudeCertification({
    compiled,
    confirmedHash: compiled.hash,
    source,
    runtimeSurfaceDigest,
    environment,
    dependencies: {
      captureBaseline: async () => ({ snapshot: { baseline: true }, digest: baselineDigest }),
      runControlLane: async () => ({ denied: true }),
      runAdapterLane: async () => ({ status: 429, code: 'rate_limit_error' }),
      verifySentinel: async () => ({ ok: false }),
      verifyBaseline: async () => ({ ok: false }),
      publishState: async () => { publications += 1; },
    },
  });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.published, false);
  assert.equal(publications, 0);
});

test('all-green fake lanes publish one Certified state bound to five evidence hashes', async () => {
  const compiled = compile();
  let published;
  let publishedPath;
  const result = await runClaudeCertification({
    compiled,
    confirmedHash: compiled.hash,
    source,
    runtimeSurfaceDigest,
    environment,
    dependencies: {
      captureBaseline: async () => ({ snapshot: { baseline: true }, digest: baselineDigest }),
      runControlLane: async () => ({ denied: true, report: { permission_denials: ['Read'] } }),
      runAdapterLane: async () => ({
        outcome: 'candidate',
        candidate: { subtype: 'success', is_error: false, terminal_reason: 'completed', permission_denials: [] },
        attemptNumber: 1,
        hookExpected: true,
        hookRunsDelta: 1,
        sessionId: '11111111-1111-4111-8111-111111111111',
      }),
      verifySentinel: async () => ({ ok: true, observed_sha256: sentinelSha256 }),
      verifyBaseline: async () => ({ ok: true, violations: [] }),
      publishState: async (path, state) => { publishedPath = path; published = state; },
      now: () => '2026-08-13T08:00:00.000Z',
      runId: () => 'cert-run-1',
    },
  });
  assert.equal(result.outcome, 'certified');
  assert.equal(result.published, true);
  assert.equal(published.mode, 'certified');
  assert.equal(publishedPath, '/opt/controller/canary-state-a/runtime-certifications/claude.json');
  assert.deepEqual(published.canary_receipt.conditions, allGreenConditions());
});

test('certification state root cannot overlap the source or disposable target', () => {
  for (const stateRoot of [
    '/opt/controller/source/state',
    '/opt/controller/canary-target-a/state',
  ]) {
    assert.throws(
      () => compile({ stateRoot }),
      (error) => error.code === 'CLAUDE_CERTIFICATION_PROFILE_INVALID',
    );
  }
});

test('each canary condition can independently reject without publishing machine state', async () => {
  const compiled = compile();
  const greenAdapter = {
    outcome: 'candidate',
    candidate: { subtype: 'success', is_error: false, terminal_reason: 'completed', permission_denials: [] },
    hookExpected: true,
    hookRunsDelta: 1,
    sessionId: '11111111-1111-4111-8111-111111111111',
  };
  const cases = [
    { runControlLane: async () => ({ denied: false }) },
    { runAdapterLane: async () => ({
      ...greenAdapter, candidate: { ...greenAdapter.candidate, permission_denials: ['Write'] },
    }) },
    { verifySentinel: async () => ({ ok: false, observed_sha256: '9'.repeat(64) }) },
    { runAdapterLane: async () => ({ ...greenAdapter, hookRuns: 99, hookRunsDelta: 0 }) },
    { verifyBaseline: async () => ({ ok: false, violations: [{ code: 'UNAUTHORIZED_MUTATION' }] }) },
  ];
  for (const override of cases) {
    let publications = 0;
    const result = await runClaudeCertification({
      compiled,
      confirmedHash: compiled.hash,
      source,
      runtimeSurfaceDigest,
      environment,
      dependencies: {
        captureBaseline: async () => ({ snapshot: { baseline: true }, digest: baselineDigest }),
        runControlLane: async () => ({ denied: true }),
        runAdapterLane: async () => greenAdapter,
        verifySentinel: async () => ({ ok: true, observed_sha256: sentinelSha256 }),
        verifyBaseline: async () => ({ ok: true, violations: [] }),
        publishState: async () => { publications += 1; },
        now: () => '2026-08-13T08:00:00.000Z',
        runId: () => 'cert-run-1',
        ...override,
      },
    });
    assert.equal(result.outcome, 'candidate_rejected');
    assert.equal(result.published, false);
    assert.equal(publications, 0);
  }
});
