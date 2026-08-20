import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { canonicalJson, validateContract } from './contract.mjs';
import {
  CLAUDE_CANARY_CONDITIONS, CLAUDE_OPAQUE_ID, publishClaudeCapabilityState, validateClaudeCapabilityState,
} from './claude-capability.mjs';
import {
  captureSnapshot, compareSnapshot, snapshotDigest,
} from './snapshot.mjs';
import { stateDirFor } from './runner-common.mjs';

const execFile = promisify(execFileCallback);
const HEX64 = /^[0-9a-f]{64}$/;
const AUTH_MODES = Object.freeze(['claude_ai', 'api_key']);
const PROFILE_FIELDS = Object.freeze([
  'auth_context_id', 'auth_mode', 'max_turns', 'runtime_surface_digest', 'sentinel_sha256',
  'source', 'state_root', 'target_root',
]);
const ARTIFACT_FIELDS = Object.freeze(['contract', 'profile', 'schema_version']);

export class ClaudeCertificationError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'ClaudeCertificationError';
    this.code = code;
    Object.assign(this, details);
  }
}

function exactFields(value, fields) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function overlaps(left, right) {
  const delta = relative(resolve(left), resolve(right));
  return delta === '' || (delta !== '..' && !delta.startsWith(`..${sep}`) && !delta.startsWith(sep));
}

function sourceValid(source) {
  if (source?.kind === 'git_checkout') {
    return exactFields(source, ['commit', 'kind', 'root_realpath'])
      && isAbsolute(source.root_realpath)
      && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(source.commit);
  }
  if (source?.kind === 'immutable_release') {
    return exactFields(source, ['kind', 'manifest_digest', 'root_realpath'])
      && isAbsolute(source.root_realpath)
      && HEX64.test(source.manifest_digest);
  }
  return false;
}

function profileValid(profile) {
  return exactFields(profile, PROFILE_FIELDS)
    && sourceValid(profile.source)
    && isAbsolute(profile.target_root)
    && isAbsolute(profile.state_root)
    && !overlaps(profile.target_root, profile.state_root)
    && !overlaps(profile.state_root, profile.target_root)
    && !overlaps(profile.source.root_realpath, profile.state_root)
    && !overlaps(profile.state_root, profile.source.root_realpath)
    && !overlaps(profile.source.root_realpath, profile.target_root)
    && !overlaps(profile.target_root, profile.source.root_realpath)
    && AUTH_MODES.includes(profile.auth_mode)
    && /^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/.test(profile.auth_context_id)
    && Number.isInteger(profile.max_turns)
    && profile.max_turns >= 1
    && profile.max_turns <= 200
    && HEX64.test(profile.runtime_surface_digest)
    && HEX64.test(profile.sentinel_sha256);
}

function outputVerifierScript(expectedSha256) {
  return [
    "const {createHash}=require('node:crypto');",
    "const {readFileSync}=require('node:fs');",
    "const actual=createHash('sha256').update(readFileSync('sentinel.output')).digest('hex');",
    `if(actual!==${JSON.stringify(expectedSha256)})process.exit(1);`,
  ].join('');
}

function fixedContract(profile) {
  const input = join(profile.target_root, 'sentinel.input');
  const output = join(profile.target_root, 'sentinel.output');
  return {
    version: 1,
    runtime: 'claude',
    objective: `Read ${input} and write its bytes unchanged to ${output}. Do not modify any other path. `
      + `The isolated controller state is ${profile.state_root}.`,
    context_sources: [{ id: 'canary-sentinel-input', path: input, sha256: profile.sentinel_sha256 }],
    target_roots: [profile.target_root],
    judgment_criteria: [{
      id: 'canary-copy-only',
      rule: 'sentinel.output exists and is byte-identical to the controller-bound sentinel input',
      why: 'The canary must prove the isolated adapter can read context and perform one exact allowed write.',
    }],
    success_criteria: [{
      id: 'canary-output-hash',
      command: 'Controller computes sentinel.output SHA-256 independently.',
      expected: `SHA-256 equals ${profile.sentinel_sha256}.`,
    }],
    constraints: [{
      id: 'canary-baseline',
      rule: `No path except ${output} changes; ambient project settings and ${profile.state_root} stay unchanged.`,
      enforcement: 'audit_only',
    }],
    allowed_mutations: { files: [output], git: [], external: [] },
    execution_permissions: {
      bash_prefixes: [], webfetch_domains: [], skills: [], additional_read_roots: [],
    },
    budget: { user_provided: true, max_turns: profile.max_turns },
    preflight: [{
      id: 'canary-git-baseline', type: 'git', target: profile.target_root, require_clean: true,
    }],
    postflight: [{
      id: 'canary-sentinel-sha256',
      type: 'command',
      cwd: profile.target_root,
      argv: ['node', '-e', outputVerifierScript(profile.sentinel_sha256)],
      capture: 'text',
    }],
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

export function compileClaudeCertificationContract({
  source, runtimeSurfaceDigest, targetRoot, stateRoot, authMode, authContextId, sentinelSha256, maxTurns,
}) {
  const profile = {
    source,
    runtime_surface_digest: runtimeSurfaceDigest,
    target_root: targetRoot,
    state_root: stateRoot,
    auth_mode: authMode,
    auth_context_id: authContextId,
    max_turns: maxTurns,
    sentinel_sha256: sentinelSha256,
  };
  if (!profileValid(profile)) {
    throw new ClaudeCertificationError(
      'CLAUDE_CERTIFICATION_PROFILE_INVALID',
      'source, absolute disposable roots, auth classification, opaque context ID, or sentinel digest is invalid',
    );
  }
  const contract = fixedContract(profile);
  const diagnostics = validateContract(contract);
  if (diagnostics.length > 0) {
    throw new ClaudeCertificationError(
      'CLAUDE_CERTIFICATION_CONTRACT_INVALID',
      'the fixed certification contract did not validate',
      { diagnostics },
    );
  }
  const artifact = { schema_version: 1, profile, contract };
  const contractBytes = canonicalJson(contract);
  const canonicalBytes = canonicalJson(artifact);
  const hash = sha256(Buffer.from(canonicalBytes, 'utf8'));
  const preview = [
    'CLAUDE RUNTIME CERTIFICATION CANARY',
    '',
    `Source: ${source.kind} ${source.root_realpath}`,
    `Auth mode: ${authMode}`,
    'auth_context_id is operator-managed, opaque, and must rotate when the principal or administrative policy context changes.',
    '',
    'Authoritative canonical JSON:',
    canonicalBytes.trimEnd(),
    '',
    `SHA-256: ${hash}`,
    '',
    'This command only compiles and previews. Running requires this exact current hash.',
  ].join('\n');
  return deepFreeze({ artifact, profile, contract, contractBytes, canonicalBytes, hash, preview });
}

export function assertFixedClaudeCertificationProfile(compiled) {
  if (!exactFields(compiled, [
    'artifact', 'canonicalBytes', 'contract', 'contractBytes', 'hash', 'preview', 'profile',
  ])
    || !exactFields(compiled.artifact, ARTIFACT_FIELDS)
    || !profileValid(compiled.profile)) {
    throw new ClaudeCertificationError(
      'CLAUDE_CERTIFICATION_PROFILE_INVALID', 'certification input is not the fixed compiled profile',
    );
  }
  const expected = compileClaudeCertificationContract({
    source: compiled.profile.source,
    runtimeSurfaceDigest: compiled.profile.runtime_surface_digest,
    targetRoot: compiled.profile.target_root,
    stateRoot: compiled.profile.state_root,
    authMode: compiled.profile.auth_mode,
    authContextId: compiled.profile.auth_context_id,
    sentinelSha256: compiled.profile.sentinel_sha256,
    maxTurns: compiled.profile.max_turns,
  });
  if (compiled.canonicalBytes !== expected.canonicalBytes
    || compiled.contractBytes !== expected.contractBytes
    || compiled.hash !== expected.hash
    || canonicalJson(compiled.artifact) !== expected.canonicalBytes
    || canonicalJson(compiled.contract) !== expected.contractBytes) {
    throw new ClaudeCertificationError(
      'CLAUDE_CERTIFICATION_PROFILE_INVALID',
      'compiled contract bytes or hash differ from the fixed profile',
    );
  }
  return expected;
}

function exactGreenConditions(conditions) {
  return exactFields(conditions, CLAUDE_CANARY_CONDITIONS)
    && CLAUDE_CANARY_CONDITIONS.every((id) => conditions[id] === true);
}

function certificationHash(value) {
  return sha256(Buffer.from(canonicalJson(value), 'utf8'));
}

export function buildClaudeCertificationReceipt(evidence) {
  if (!exactGreenConditions(evidence?.conditions)) {
    throw new ClaudeCertificationError(
      'CLAUDE_CERTIFICATION_INCOMPLETE',
      'all five controller-owned canary conditions must be present and true',
    );
  }
  const receipt = {
    schema_version: 1,
    source: evidence.source,
    runtime_surface_digest: evidence.runtimeSurfaceDigest,
    environment: evidence.environment,
    canary_contract_hash: evidence.contractHash,
    baseline_digest: evidence.baselineDigest,
    run_identity: evidence.runIdentity,
    conditions: evidence.conditions,
    evidence_aggregate_hash: certificationHash(evidence.evidence),
    candidate_result_hash: certificationHash(evidence.candidateResult),
    postflight_report_hash: certificationHash(evidence.postflightReport),
    certified_at: evidence.certifiedAt,
  };
  // The capability schema is the final closed-world receipt validator.
  const state = {
    schema_version: 1,
    mode: 'certified',
    changed_at: evidence.certifiedAt,
    active_source: evidence.source,
    runtime_surface_digest: evidence.runtimeSurfaceDigest,
    environment: evidence.environment,
    canary_receipt: receipt,
  };
  const reasons = validateClaudeCapabilityState(state);
  if (reasons.length > 0) {
    throw new ClaudeCertificationError(
      'CLAUDE_CERTIFICATION_EVIDENCE_INVALID', reasons.join('; '), { reasons },
    );
  }
  return receipt;
}

export function classifyClaudeCanaryBlocker(result) {
  if (result instanceof TypeError || result instanceof SyntaxError) return 'controller_error';
  if (result?.outcome === 'controller_error') return 'controller_error';
  const code = String(result?.code ?? result?.error?.code ?? '');
  const message = String(result?.message ?? result?.error?.message ?? '');
  const reasons = Array.isArray(result?.reasons) ? result.reasons.join(' ') : '';
  const apiStatus = Number(result?.api_error_status ?? result?.status);
  // 词表只匹配错误载体字段的闭集（code/message/reasons/errors），不匹配整包序列化：
  // 2.1.231 起健康 envelope 的 modelUsage 自带 "provider":"firstParty"，整包 grep 会把
  // 每一份正常 control report 误判成 provider 阻塞（实测 2026-08-13，认证因此永远 blocked）。
  const errorTexts = Array.isArray(result?.errors) ? result.errors.map(String).join(' ') : '';
  if (apiStatus === 429
    || apiStatus >= 500
    || result?.provider_error === true
    || /(?:rate.?limit|quota|subscription|session.?limit|provider|overloaded|network|timeout|ECONN|ENET|EAI_AGAIN)/i
      .test(`${code} ${message} ${reasons} ${errorTexts}`)) return 'blocked';
  if (result?.outcome === 'candidate_rejected') return 'candidate_rejected';
  return result instanceof Error ? 'controller_error' : 'candidate_rejected';
}

async function defaultCaptureBaseline({ contract }) {
  const snapshot = await captureSnapshot(contract, { phase: 'capture' });
  return { snapshot, digest: snapshotDigest(snapshot) };
}

async function defaultControlLane({ compiled }) {
  const prompt = 'Read sentinel.input using the Read tool. This control lane expects the ambient project deny to refuse that read.';
  try {
    const { stdout } = await execFile('claude', [
      '-p', prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits', '--max-turns', '1',
    ], { cwd: compiled.profile.target_root, maxBuffer: 4 * 1024 * 1024 });
    const report = JSON.parse(stdout);
    const interpreted = interpretClaudeControlReport(report, compiled);
    if (interpreted.outcome === 'blocked') throw report;
    return { denied: interpreted.denied, report };
  } catch (error) {
    if (typeof error?.stdout === 'string') {
      try {
        const report = JSON.parse(error.stdout);
        const interpreted = interpretClaudeControlReport(report, compiled);
        if (interpreted.outcome === 'blocked') throw report;
        if (Array.isArray(report?.permission_denials)) {
          return { denied: interpreted.denied, report };
        }
      } catch (structured) {
        if (classifyClaudeCanaryBlocker(structured) === 'blocked') throw structured;
      }
    }
    throw error;
  }
}

export function exactSentinelReadDenial(report, compiled) {
  const expected = resolve(compiled.profile.target_root, 'sentinel.input');
  return Array.isArray(report?.permission_denials)
    && report.permission_denials.some((denial) => denial?.tool_name === 'Read'
      && typeof denial?.tool_input?.file_path === 'string'
      && resolve(compiled.profile.target_root, denial.tool_input.file_path) === expected);
}

export function interpretClaudeControlReport(report, compiled) {
  if (classifyClaudeCanaryBlocker(report) === 'blocked') return { outcome: 'blocked' };
  return { outcome: 'observed', denied: exactSentinelReadDenial(report, compiled) };
}

async function defaultAdapterLane({ compiled, baselineDigest, runId }) {
  const { prepareClaude, runClaudeCertificationAttempt } = await import('./runners/claude.mjs');
  const runtimeContractHash = sha256(Buffer.from(compiled.contractBytes, 'utf8'));
  // 认证是一次性 canary：每次 run 必须落在自己的空目录里，绝不复用上一轮的残骸。
  // 旧实现只按 (state_root, contract hash) 派生，而 contract bytes 不含被认证的 release 身份
  // （它在 profile 里），于是「用同一套 canary 参数认证下一个 release」直接落进上一轮用过的目录，
  // 带着那里的 thread.json / candidate.json / hook-started-at 起跑，报出与真实原因无关的
  // candidate_rejected（2026-08-14 实战两次必败，归档目录后立刻通过；信任根台账「认证操作坑」）。
  // 目录末段仍须是 contract hash——runners/claude.mjs 拿 basename(stateDir) 与 binding.contractHash
  // 做交叉校验——所以 run 维度只能加在 controller 段。
  // runId 的合法性已在 runClaudeCertification 生成处判过（与 receipt 同一条判据）；这里只保留
  // 路径安全的兜底，因为本函数也可被单独调用。
  if (typeof runId !== 'string' || !CLAUDE_OPAQUE_ID.test(runId) || runId.includes('/')) {
    throw new ClaudeCertificationError(
      'CLAUDE_CERTIFICATION_RUN_ID_INVALID', 'run id must be an opaque path-safe identifier',
    );
  }
  const stateDir = stateDirFor({
    stateRoot: compiled.profile.state_root,
    controller: `claude-certification/${runId}`,
    contractHash: runtimeContractHash,
  });
  // 「每次 run 一个空目录」是本修复的全部依据，但它此前只是「相信 runId 每次都新」。runId 可注入
  // （单测就固定成 'cert-run-1'），一旦复用，prepare 会带着上一轮的 thread.json 起跑，落回那条
  // 与真实原因无关的 candidate_rejected——即本修复要消灭的形态。所以直接断言目录是新的。
  if (await lstat(stateDir).then(() => true, () => false)) {
    throw new ClaudeCertificationError(
      'CLAUDE_CERTIFICATION_STATE_DIR_REUSED',
      'the derived certification state directory already exists; each canary run requires a fresh one',
    );
  }
  await prepareClaude({
    contract: compiled.contract,
    contractPath: join(compiled.profile.state_root, 'claude-certification-contract.json'),
    stateDir,
  });
  return runClaudeCertificationAttempt({
    compiled,
    contract: compiled.contract,
    stateDir,
    binding: { contractHash: runtimeContractHash, baselineDigest, runId },
    prompt: compiled.contract.objective,
    kind: 'launch',
  });
}

async function defaultVerifySentinel({ compiled }) {
  try {
    const bytes = await readFile(join(compiled.profile.target_root, 'sentinel.output'));
    const observed = sha256(bytes);
    return { ok: observed === compiled.profile.sentinel_sha256, observed_sha256: observed };
  } catch {
    return { ok: false, observed_sha256: null };
  }
}

async function defaultAssertSentinelAbsent({ compiled }) {
  try {
    await lstat(join(compiled.profile.target_root, 'sentinel.output'));
    return { ok: false };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true };
    throw error;
  }
}

async function defaultVerifyBaseline({ compiled, baseline, baselineDigest: expectedBaselineDigest }) {
  // `?? []` 对齐 codex-controller/src/cli.mjs 的同名助手：形状不合法的 baseline 应当落到
  // compareSnapshot 的结构化诊断（它自己也用 `baseline?.entries ?? []`），而不是在这里抛
  // 未捕获的 TypeError——runClaudeCertification 调用本函数时没有 try/catch，操作员会拿到
  // 非结构化报错而不是 SNAPSHOT_ENTRY_INVALID / BASELINE_DIGEST_MISMATCH。
  const baselineGitHeads = Object.fromEntries((baseline?.entries ?? [])
    .filter((entry) => entry.type === 'git')
    .map((entry) => [entry.id, entry.head]));
  const current = await captureSnapshot(compiled.contract, { baselineGitHeads, phase: 'verify' });
  const comparison = compareSnapshot(compiled.contract, baseline, current, { expectedBaselineDigest });
  const postflight = [];
  for (const entry of compiled.contract.postflight) {
    try {
      await execFile(entry.argv[0], entry.argv.slice(1), { cwd: entry.cwd, maxBuffer: 1024 * 1024 });
      postflight.push({ id: entry.id, exit: 0 });
    } catch (error) {
      postflight.push({ id: entry.id, exit: Number.isInteger(error?.code) ? error.code : null });
    }
  }
  return {
    ok: comparison.ok && postflight.every((entry) => entry.exit === 0),
    violations: comparison.violations,
    postflight,
  };
}

export async function runClaudeCertification({
  compiled,
  confirmedHash,
  source,
  runtimeSurfaceDigest,
  environment,
  dependencies = {},
}) {
  const fixed = assertFixedClaudeCertificationProfile(compiled);
  const capabilityStatePath = join(
    fixed.profile.state_root,
    'runtime-certifications',
    'claude.json',
  );
  if (confirmedHash !== fixed.hash) {
    throw new ClaudeCertificationError(
      'CLAUDE_CERTIFICATION_CONFIRMATION_MISMATCH',
      'confirmed hash is not the current fixed canary contract hash',
    );
  }
  if (canonicalJson(source) !== canonicalJson(fixed.profile.source)
    || runtimeSurfaceDigest !== fixed.profile.runtime_surface_digest
    || environment?.auth_mode !== fixed.profile.auth_mode
    || environment?.auth_context_id !== fixed.profile.auth_context_id
    || !HEX64.test(runtimeSurfaceDigest ?? '')) {
    throw new ClaudeCertificationError(
      'CLAUDE_CERTIFICATION_CONTEXT_MISMATCH',
      'current source, runtime surface, or non-secret auth context differs from the compiled profile',
    );
  }

  const captureBaselineImpl = dependencies.captureBaseline ?? defaultCaptureBaseline;
  const assertSentinelAbsent = dependencies.assertSentinelAbsent ?? defaultAssertSentinelAbsent;
  const runControlLane = dependencies.runControlLane ?? defaultControlLane;
  const runAdapterLane = dependencies.runAdapterLane ?? defaultAdapterLane;
  const verifySentinel = dependencies.verifySentinel ?? defaultVerifySentinel;
  const verifyBaseline = dependencies.verifyBaseline ?? defaultVerifyBaseline;
  const publishState = dependencies.publishState ?? publishClaudeCapabilityState;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const makeRunId = dependencies.runId ?? (() => randomUUID());

  const sentinelInitial = await assertSentinelAbsent({ compiled: fixed });
  if (sentinelInitial?.ok !== true) {
    return {
      outcome: 'candidate_rejected', published: false,
      reasons: ['sentinel-output already existed before the certification attempt'],
    };
  }
  const baseline = await captureBaselineImpl({ contract: fixed.contract, compiled: fixed });
  if (!HEX64.test(baseline?.digest ?? '')) {
    throw new ClaudeCertificationError(
      'CLAUDE_CERTIFICATION_BASELINE_INVALID', 'capture did not return a trusted lowercase SHA-256 digest',
    );
  }
  // runId 同时进 receipt 的 run_identity 和 state 目录路径，所以判据必须与 receipt 侧同一条，
  // 且必须在任何副作用之前判：否则宽的那处放行、窄的那处在整轮 canary 跑完、state 已落盘之后才抛
  // （2026-08-20 并行审实测 `-foo` 正是这个形态）。dependencies.runId 可注入，故不能只信默认实现。
  const runId = makeRunId();
  if (typeof runId !== 'string' || !CLAUDE_OPAQUE_ID.test(runId)) {
    throw new ClaudeCertificationError(
      'CLAUDE_CERTIFICATION_RUN_ID_INVALID',
      'run id must be an opaque identifier that starts with an alphanumeric character',
    );
  }

  // 每个非 certified 出口都必须回传 run_id：state 目录名现在含 runId，不报出来的话本轮证据
  // （attempts/*-result.json、candidate.json、thread.json、hook-runs.jsonl）就躺在一个从未出现在
  // 任何输出里的随机目录中，只能靠 ls + mtime 猜。旧实现那条确定路径正是 2026-08-14 定位根因
  // 所依赖的东西，per-run 目录不能把这份可运维性一起换掉（2026-08-20 并行审指出）。
  const rejected = (outcome, reasons) => ({
    outcome, published: false, run_id: runId, reasons,
  });

  let control;
  try {
    control = await runControlLane({ compiled: fixed, runId });
  } catch (error) {
    const outcome = classifyClaudeCanaryBlocker(error);
    return rejected(outcome, ['Claude control lane was unavailable']);
  }
  if (control?.denied !== true) {
    return rejected('candidate_rejected', ['ambient-deny-control did not observe the required Read denial']);
  }

  const sentinelBeforeAdapter = await assertSentinelAbsent({ compiled: fixed });
  if (sentinelBeforeAdapter?.ok !== true) {
    return rejected('candidate_rejected',
      ['sentinel-output was created by the control lane before the isolated adapter attempt']);
  }

  let adapter;
  try {
    adapter = await runAdapterLane({
      compiled: fixed, baselineDigest: baseline.digest, runId,
    });
  } catch (error) {
    const outcome = classifyClaudeCanaryBlocker(error);
    return rejected(outcome, ['Claude isolated adapter lane was unavailable']);
  }
  if (adapter?.outcome !== 'candidate') {
    const outcome = classifyClaudeCanaryBlocker(adapter);
    return rejected(outcome, ['isolated adapter did not produce an exact candidate']);
  }

  const sentinel = await verifySentinel({ compiled: fixed, adapter });
  const baselineReport = await verifyBaseline({
    compiled: fixed, baseline: baseline.snapshot, baselineDigest: baseline.digest, adapter,
  });
  const conditions = {
    'ambient-deny-control': control.denied === true,
    'isolated-adapter-candidate': adapter.candidate?.subtype === 'success'
      && adapter.candidate?.is_error === false
      && adapter.candidate?.terminal_reason === 'completed'
      && Array.isArray(adapter.candidate?.permission_denials)
      && adapter.candidate.permission_denials.length === 0,
    'sentinel-output': sentinelInitial.ok === true && sentinelBeforeAdapter.ok === true && sentinel?.ok === true
      && sentinel.observed_sha256 === fixed.profile.sentinel_sha256,
    'flag-settings-hook': adapter.hookExpected === true && adapter.hookRunsDelta >= 1,
    'baseline-preserved': baselineReport?.ok === true,
  };
  const evidence = {
    'ambient-deny-control': { ok: conditions['ambient-deny-control'] },
    'isolated-adapter-candidate': {
      ok: conditions['isolated-adapter-candidate'],
      permission_denials_count: Array.isArray(adapter.candidate?.permission_denials)
        ? adapter.candidate.permission_denials.length : null,
    },
    'sentinel-output': {
      ok: conditions['sentinel-output'],
      absent_before_control: sentinelInitial.ok === true,
      absent_before_adapter: sentinelBeforeAdapter.ok === true,
      observed_sha256: sentinel?.observed_sha256 ?? null,
    },
    'flag-settings-hook': {
      ok: conditions['flag-settings-hook'],
      hook_expected: adapter.hookExpected === true,
      hook_runs_delta: Number.isInteger(adapter.hookRunsDelta) ? adapter.hookRunsDelta : null,
    },
    'baseline-preserved': {
      ok: conditions['baseline-preserved'],
      violation_count: Array.isArray(baselineReport?.violations) ? baselineReport.violations.length : null,
    },
  };
  if (!exactGreenConditions(conditions)) {
    return {
      outcome: 'candidate_rejected', published: false,
      reasons: CLAUDE_CANARY_CONDITIONS.filter((id) => conditions[id] !== true),
    };
  }

  const certifiedAt = now();
  const receipt = buildClaudeCertificationReceipt({
    source,
    runtimeSurfaceDigest,
    environment,
    contractHash: fixed.hash,
    baselineDigest: baseline.digest,
    runIdentity: { run_id: runId, session_id: adapter.sessionId },
    conditions,
    evidence,
    candidateResult: adapter.candidate,
    postflightReport: baselineReport,
    certifiedAt,
  });
  const state = {
    schema_version: 1,
    mode: 'certified',
    changed_at: certifiedAt,
    active_source: source,
    runtime_surface_digest: runtimeSurfaceDigest,
    environment,
    canary_receipt: receipt,
  };
  await publishState(capabilityStatePath, state);
  return { outcome: 'certified', published: true, state, receipt };
}
