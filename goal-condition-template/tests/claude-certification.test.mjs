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
    // errors 是闭集里唯一真实出现在 envelope（error_max_turns 形态）上的文本字段，必须有一条
    // 只靠它判定的用例：下面那条 line 132 的 errors 同时带 api_error_status，数值分支先命中，
    // 词表支路等于零覆盖——删掉 haystack 里的 errorTexts 也能全绿（2026-08-14 并行审发现）。
    { errors: ['upstream provider overloaded'] },
  ]) assert.equal(classifyClaudeCanaryBlocker(result), 'blocked');
  assert.equal(classifyClaudeCanaryBlocker({ outcome: 'candidate_rejected' }), 'candidate_rejected');
  assert.equal(classifyClaudeCanaryBlocker(new TypeError('controller bug')), 'controller_error');
  assert.equal(interpretClaudeControlReport({
    api_error_status: 429, permission_denials: [], errors: ['rate limit'],
  }, compile()).outcome, 'blocked');
});

test('healthy envelope metadata never classifies blocked and exact denial is observed', () => {
  // 实测 2026-08-13：2.1.231 健康 envelope 的 modelUsage 带 "provider":"firstParty"，
  // 旧实现对整包序列化 grep 词表，每一份正常 control report 都被误判 blocked，认证永远起不来。
  const compiled = compile();
  const healthy = {
    subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns',
    errors: ['Reached maximum number of turns (1)'],
    modelUsage: { 'claude-fable-5': { inputTokens: 2, outputTokens: 420, provider: 'firstParty' } },
    permission_denials: [{
      tool_name: 'Read', tool_use_id: 'toolu_x',
      tool_input: { file_path: `${compiled.profile.target_root}/sentinel.input` },
    }],
  };
  assert.notEqual(classifyClaudeCanaryBlocker(healthy), 'blocked');
  const interpreted = interpretClaudeControlReport(healthy, compiled);
  assert.equal(interpreted.outcome, 'observed');
  assert.equal(interpreted.denied, true);
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

test('control lane cannot create sentinel output and transfer write attribution to the adapter lane', async () => {
  const compiled = compile();
  let absenceChecks = 0;
  let adapterCalls = 0;
  const result = await runClaudeCertification({
    compiled, confirmedHash: compiled.hash, source, runtimeSurfaceDigest, environment,
    dependencies: {
      assertSentinelAbsent: async () => ({ ok: ++absenceChecks === 1 }),
      captureBaseline: async () => ({ snapshot: { baseline: true }, digest: baselineDigest }),
      runControlLane: async () => ({ denied: true }),
      runAdapterLane: async () => { adapterCalls += 1; },
    },
  });
  assert.equal(result.outcome, 'candidate_rejected');
  assert.equal(absenceChecks, 2);
  assert.equal(adapterCalls, 0);
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

// runId 同时进 receipt 的 run_identity 与 state 目录路径，所以判据必须与 receipt 侧同一条、
// 且在任何副作用之前判——宽的那处放行、窄的那处在整轮 canary 跑完之后才抛，是最贵的失败形态
// （2026-08-20 并行审实测 `-foo` 正是这个形态）。同时：失败出口必须回传 run_id，否则本轮证据
// 躺在一个随机名目录里、从未出现在任何输出中。
test('an unusable run id fails before any lane runs, and rejections still name the run', async () => {
  const compiled = compile();
  const lanes = () => {
    let touched = 0;
    return {
      calls: () => touched,
      deps: {
        captureBaseline: async () => ({ snapshot: { baseline: true }, digest: baselineDigest }),
        runControlLane: async () => { touched += 1; return { denied: true }; },
        runAdapterLane: async () => { touched += 1; },
      },
    };
  };
  for (const badRunId of ['-leading-dash', '', 'has/slash', null, undefined, 42]) {
    const lane = lanes();
    await assert.rejects(
      () => runClaudeCertification({
        compiled, confirmedHash: compiled.hash, source, runtimeSurfaceDigest, environment,
        dependencies: { ...lane.deps, runId: () => badRunId },
      }),
      (error) => error.code === 'CLAUDE_CERTIFICATION_RUN_ID_INVALID',
      `run id ${JSON.stringify(badRunId)} must be rejected`,
    );
    assert.equal(lane.calls(), 0, 'no lane may run before the run id is validated');
  }
  // 非 certified 出口带 run_id：否则操作员找不到本轮的 state 目录取证。
  const lane = lanes();
  const rejectedResult = await runClaudeCertification({
    compiled, confirmedHash: compiled.hash, source, runtimeSurfaceDigest, environment,
    dependencies: {
      ...lane.deps,
      runControlLane: async () => ({ denied: false }),
      runId: () => 'cert-run-reject',
    },
  });
  assert.equal(rejectedResult.published, false);
  assert.equal(rejectedResult.run_id, 'cert-run-reject');
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
