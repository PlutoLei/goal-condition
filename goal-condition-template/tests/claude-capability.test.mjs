import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, readFileSync } from 'node:fs';
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

// G4（2026-08-14）：命令行少传 capability flag 时，旧实现让 context 塌成 undefined，诊断只剩四条
// 与 flag 无关的泛化原因（source 无效 / surface 无效 / environment 无效 / state 缺失），操作员看不出
// 该补哪个参数。缺 flag 现在单独成一条指路诊断，且不与「flag 齐但内容不合格」混在一起。
test('missing capability flags are named instead of collapsing into the generic reasons', () => {
  const verdict = evaluateClaudeCapability({ missingFlags: ['--source', '--capability-state'] });
  assert.equal(verdict.mode, 'candidate');
  assert.deepEqual(verdict.reasons, [
    'Claude capability flags are missing from this command: --source --capability-state',
  ]);
  // 泛化原因必须让位，否则「补哪个参数」照旧淹没在四条噪声里。
  for (const generic of ['identity is invalid', 'surface digest is invalid', 'environment is invalid', 'state is missing']) {
    assert.ok(!verdict.reasons.join(' ').includes(generic), `generic reason leaked: ${generic}`);
  }
  let thrown;
  try {
    assertClaudeCertified({ missingFlags: ['--auth-mode'] });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, 'assertClaudeCertified must fail closed when capability flags are missing');
  assert.equal(thrown.code, 'CLAUDE_CAPABILITY_UNCERTIFIED');
  assert.match(thrown.message, /--auth-mode/);
  // 闭世界：不是本模块声明的 flag 一律不进诊断文本，也不得因此吞掉真实评估。
  const forged = evaluateClaudeCapability({ missingFlags: ['--not-a-real-flag'] });
  assert.ok(!forged.reasons.join(' ').includes('--not-a-real-flag'));
  assert.ok(forged.reasons.length > 1, 'forged flag names must not short-circuit the real evaluation');
});

// 同一病灶的另一半（2026-08-15 并行审 Codex + DeepSeek 收敛）：state 文件存在但不安全时，
// readClaudeCapabilityState 已经算出了精确原因，调用方却把它丢掉、只留一句「state is missing」，
// 于是操作员被指去补一个其实存在的文件。精确原因现在直通，但通道要挡住路径与内容片段。
test('a precise capability-state read failure survives instead of collapsing to "missing"', () => {
  const verdict = evaluateClaudeCapability({
    stateReasons: ['Claude capability state must be a single-link mode-0600 regular file'],
  });
  assert.equal(verdict.mode, 'candidate');
  assert.deepEqual(verdict.reasons, ['Claude capability state must be a single-link mode-0600 regular file']);
  assert.ok(!verdict.reasons.join(' ').includes('state is missing'), 'the vague reason must not survive alongside');

  // 自维护：直接从模块源码抽出它能产生的全部原因，逐条要求活着穿过隐私闸。手写代表样本会漏——
  // 初版字符白名单就是被 `schema_version/mode/...` 那条含 `/` 的原因整条吃掉，而样本恰好没选它。
  const moduleSource = readFileSync(new URL('../scripts/lib/claude-capability.mjs', import.meta.url), 'utf8');
  const emitted = [...moduleSource.matchAll(/(?:missing|invalid|push|return \[)\('([^']{20,})'\)?/g)]
    .map((match) => match[1]);
  assert.ok(emitted.length >= 15, `expected to harvest this module's reason strings, found ${emitted.length}`);
  for (const reason of emitted) {
    assert.deepEqual(
      evaluateClaudeCapability({ stateReasons: [reason] }).reasons, [reason],
      `a reason this module itself emits was dropped by the privacy guard: ${reason}`,
    );
  }

  // 隐私闸：路径、JSON 片段、非字符串一律不得进诊断，且不得因此短路掉真实评估。
  // 路径样本按仓内既有手法拼接——仓库自带的「不得泄露机器标识数据」全仓闸会拦下字面写法。
  const homePrefix = `${'/'}Users${'/'}`;
  for (const forged of [
    [`${homePrefix}someone/capability.json is unreadable`],
    ['{"auth_context_id":"exposed"}'],
    [42], [null], 'not-an-array', undefined,
  ]) {
    const guarded = evaluateClaudeCapability({ stateReasons: forged });
    const text = guarded.reasons.join(' ');
    assert.ok(!text.includes(homePrefix), `path leaked into diagnostics: ${text}`);
    assert.ok(!text.includes('exposed'), `state content leaked into diagnostics: ${text}`);
    assert.ok(guarded.reasons.length > 1, 'a rejected reason channel must fall through to the real evaluation');
  }
});

// 两条短路必须压过一份本来合格的 context，否则把它们挪进 `state === undefined` 分支、或放到
// certified 判定之后，现有测试仍全绿，而 launcher 将来演进成「能解析多少带多少」时，缺参数的
// 命令行会拿到 Certified 判定。这条 fail-closed 不变式此前无人守（2026-08-15 并行审指出）。
test('missing flags and state-read failures outrank an otherwise certified context', () => {
  const certifiedContext = {
    state: certifiedState(), source: checkoutSource, runtimeSurfaceDigest: H.runtime, environment,
  };
  assert.equal(evaluateClaudeCapability(certifiedContext).mode, 'certified');
  for (const short of [
    { missingFlags: ['--capability-state'] },
    { stateReasons: ['Claude capability state is not valid UTF-8 JSON'] },
  ]) {
    const verdict = evaluateClaudeCapability({ ...certifiedContext, ...short });
    assert.equal(verdict.mode, 'candidate', `a complete context must not overrule ${Object.keys(short)[0]}`);
  }
});

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
