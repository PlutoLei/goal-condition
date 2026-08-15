import { randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import {
  chmod, lstat, mkdir, open, rename, rm,
} from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { TextDecoder } from 'node:util';

import { canonicalJson } from './contract.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const GIT_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const OPAQUE_ID = /^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/;
const AUTH_MODES = Object.freeze(['claude_ai', 'api_key']);

const STATE_FIELDS = Object.freeze([
  'active_source', 'canary_receipt', 'changed_at', 'environment', 'mode',
  'runtime_surface_digest', 'schema_version',
]);
const ENVIRONMENT_FIELDS = Object.freeze([
  'arch', 'auth_context_id', 'auth_mode', 'cli_version', 'os',
]);
const CHECKOUT_SOURCE_FIELDS = Object.freeze(['commit', 'kind', 'root_realpath']);
const RELEASE_SOURCE_FIELDS = Object.freeze(['kind', 'manifest_digest', 'root_realpath']);
const RECEIPT_FIELDS = Object.freeze([
  'baseline_digest', 'candidate_result_hash', 'canary_contract_hash', 'certified_at',
  'conditions', 'environment', 'evidence_aggregate_hash', 'postflight_report_hash',
  'run_identity', 'runtime_surface_digest', 'schema_version', 'source',
]);
const RUN_IDENTITY_FIELDS = Object.freeze(['run_id', 'session_id']);

export const CLAUDE_CANARY_CONDITIONS = Object.freeze([
  'ambient-deny-control',
  'isolated-adapter-candidate',
  'sentinel-output',
  'flag-settings-hook',
  'baseline-preserved',
]);

export class ClaudeCapabilityError extends Error {
  constructor(code, message, reasons = []) {
    super(`${code}: ${message}`);
    this.name = 'ClaudeCapabilityError';
    this.code = code;
    this.reasons = reasons;
  }
}

function exactFields(value, fields) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validSource(source) {
  if (source?.kind === 'git_checkout') {
    return exactFields(source, CHECKOUT_SOURCE_FIELDS)
      && typeof source.root_realpath === 'string'
      && isAbsolute(source.root_realpath)
      && GIT_COMMIT.test(source.commit);
  }
  if (source?.kind === 'immutable_release') {
    return exactFields(source, RELEASE_SOURCE_FIELDS)
      && typeof source.root_realpath === 'string'
      && isAbsolute(source.root_realpath)
      && HEX64.test(source.manifest_digest);
  }
  return false;
}

function validEnvironment(environment) {
  return exactFields(environment, ENVIRONMENT_FIELDS)
    && typeof environment.cli_version === 'string'
    && VERSION.test(environment.cli_version)
    && typeof environment.os === 'string'
    && OPAQUE_ID.test(environment.os)
    && typeof environment.arch === 'string'
    && OPAQUE_ID.test(environment.arch)
    && AUTH_MODES.includes(environment.auth_mode)
    && typeof environment.auth_context_id === 'string'
    && OPAQUE_ID.test(environment.auth_context_id);
}

function validConditions(conditions) {
  return exactFields(conditions, CLAUDE_CANARY_CONDITIONS)
    && CLAUDE_CANARY_CONDITIONS.every((condition) => conditions[condition] === true);
}

function validRunIdentity(identity) {
  return exactFields(identity, RUN_IDENTITY_FIELDS)
    && OPAQUE_ID.test(identity.run_id)
    && OPAQUE_ID.test(identity.session_id);
}

function validReceipt(receipt) {
  return exactFields(receipt, RECEIPT_FIELDS)
    && receipt.schema_version === 1
    && validSource(receipt.source)
    && HEX64.test(receipt.runtime_surface_digest)
    && validEnvironment(receipt.environment)
    && HEX64.test(receipt.canary_contract_hash)
    && HEX64.test(receipt.baseline_digest)
    && validRunIdentity(receipt.run_identity)
    && validConditions(receipt.conditions)
    && HEX64.test(receipt.evidence_aggregate_hash)
    && HEX64.test(receipt.candidate_result_hash)
    && HEX64.test(receipt.postflight_report_hash)
    && validTimestamp(receipt.certified_at);
}

export function validateClaudeCapabilityState(state) {
  const reasons = [];
  if (!exactFields(state, STATE_FIELDS)) {
    return ['capability state does not have the exact schema_version/mode/source/runtime/environment/receipt fields'];
  }
  if (state.schema_version !== 1) reasons.push('capability state schema_version is not 1');
  if (!['candidate', 'certified'].includes(state.mode)) reasons.push('capability state mode is not candidate or certified');
  if (!validTimestamp(state.changed_at)) reasons.push('capability state changed_at is not a canonical timestamp');
  if (!validSource(state.active_source)) reasons.push('capability state active_source is malformed');
  if (!HEX64.test(state.runtime_surface_digest ?? '')) reasons.push('capability runtime surface digest is malformed');
  if (!validEnvironment(state.environment)) reasons.push('capability environment is malformed or contains an unsupported auth mode');
  if (state.mode === 'candidate' && state.canary_receipt !== null) {
    reasons.push('candidate capability state must not carry a receipt');
  }
  if (state.mode === 'certified' && !validReceipt(state.canary_receipt)) {
    reasons.push('certified capability state receipt is missing, malformed, or incomplete');
  }
  return reasons;
}

function sameValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

// capability context 的四个必需 flag。清单在这里定义、由 launcher 引用，避免两处各写一份漂移。
export const CLAUDE_CAPABILITY_FLAGS = Object.freeze([
  '--source', '--auth-mode', '--auth-context-id', '--capability-state',
]);

export function evaluateClaudeCapability({
  state, source, runtimeSurfaceDigest, environment, missingFlags,
}) {
  // 「命令行少传了 flag」和「flag 都在但认证内容不合格」是两类事，前者只需补参数、后者要查认证
  // 状态。旧实现让两者都落到下面四条与 flag 无关的泛化原因上，操作员看不出该干什么（G4）。
  // 只接受本模块自己声明的闭集成员，调用方传进来的其他字符串一律忽略，不进诊断文本。
  const namedFlags = Array.isArray(missingFlags)
    ? CLAUDE_CAPABILITY_FLAGS.filter((flag) => missingFlags.includes(flag))
    : [];
  if (namedFlags.length > 0) {
    return {
      mode: 'candidate',
      reasons: [`Claude capability flags are missing from this command: ${namedFlags.join(' ')}`],
    };
  }
  const reasons = [];
  if (!validSource(source)) reasons.push('current Claude source identity is invalid or unverified');
  if (!HEX64.test(runtimeSurfaceDigest ?? '')) reasons.push('current Claude runtime surface digest is invalid');
  if (!validEnvironment(environment)) reasons.push('current Claude environment is invalid or unsupported');
  if (state === undefined || state === null) {
    reasons.push('Claude capability state is missing');
    return { mode: 'candidate', reasons };
  }
  reasons.push(...validateClaudeCapabilityState(state));
  if (reasons.length > 0) return { mode: 'candidate', reasons: [...new Set(reasons)] };
  if (state.mode !== 'certified') reasons.push('Claude capability state is Candidate');
  if (!sameValue(state.active_source, source)) reasons.push('Claude source identity differs from the certified source');
  if (state.runtime_surface_digest !== runtimeSurfaceDigest) reasons.push('Claude runtime surface digest drifted');
  if (!sameValue(state.environment, environment)) reasons.push('Claude environment differs from the certified environment');

  const receipt = state.canary_receipt;
  if (receipt !== null) {
    if (!sameValue(receipt.source, state.active_source)) reasons.push('receipt source does not bind the active source');
    if (receipt.runtime_surface_digest !== state.runtime_surface_digest) {
      reasons.push('receipt runtime surface digest does not bind the active runtime');
    }
    if (!sameValue(receipt.environment, state.environment)) reasons.push('receipt environment does not bind the active environment');
    if (!sameValue(receipt.source, source)) reasons.push('receipt source differs from the current source');
    if (receipt.runtime_surface_digest !== runtimeSurfaceDigest) reasons.push('receipt runtime surface digest differs from current runtime');
    if (!sameValue(receipt.environment, environment)) reasons.push('receipt environment differs from current environment');
  }
  return reasons.length === 0
    ? { mode: 'certified', reasons: [] }
    : { mode: 'candidate', reasons: [...new Set(reasons)] };
}

export function assertClaudeCertified(context) {
  const verdict = evaluateClaudeCapability(context ?? {});
  if (verdict.mode === 'certified') return verdict;
  throw new ClaudeCapabilityError(
    'CLAUDE_CAPABILITY_UNCERTIFIED',
    verdict.reasons.join('; '),
    verdict.reasons,
  );
}

export async function readClaudeCapabilityState(pathname, nofollow = constants.O_NOFOLLOW) {
  const missing = (reason) => ({ ok: false, missing: true, reasons: [reason] });
  const invalid = (reason) => ({ ok: false, missing: false, reasons: [reason] });
  const parent = dirname(pathname);
  if (!existsSync(parent)) return missing('Claude capability state directory is missing');
  let parentStat;
  try {
    parentStat = await lstat(parent);
  } catch (error) {
    return error?.code === 'ENOENT'
      ? missing('Claude capability state directory is missing')
      : invalid('Claude capability state directory cannot be inspected safely');
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o7777) !== 0o700) {
    return invalid('Claude capability state directory must be a real mode-0700 directory');
  }
  if (typeof nofollow !== 'number') {
    return existsSync(pathname)
      ? invalid('Claude capability state cannot be read without O_NOFOLLOW support')
      : missing('Claude capability state is missing');
  }
  let handle;
  try {
    handle = await open(pathname, constants.O_RDONLY | nofollow);
  } catch (error) {
    return error?.code === 'ENOENT'
      ? missing('Claude capability state is missing')
      : invalid('Claude capability state cannot be opened without following links');
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o7777) !== 0o600) {
      return invalid('Claude capability state must be a single-link mode-0600 regular file');
    }
    let state;
    try {
      const bytes = await handle.readFile();
      state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      return invalid('Claude capability state is not valid UTF-8 JSON');
    }
    const reasons = validateClaudeCapabilityState(state);
    return reasons.length === 0
      ? { ok: true, missing: false, state, reasons: [] }
      : { ok: false, missing: false, reasons };
  } finally {
    await handle.close();
  }
}

export async function publishClaudeCapabilityState(pathname, state, {
  beforeRename = async () => {},
  writeImpl = async (handle, bytes) => handle.writeFile(bytes),
  renameImpl = rename,
} = {}) {
  const reasons = validateClaudeCapabilityState(state);
  if (reasons.length > 0) {
    throw new ClaudeCapabilityError('CLAUDE_CAPABILITY_STATE_INVALID', reasons.join('; '), reasons);
  }
  const parent = dirname(pathname);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new ClaudeCapabilityError('CLAUDE_CAPABILITY_PARENT_UNSAFE', 'capability parent is not a real directory');
  }
  await chmod(parent, 0o700);

  const temporary = join(parent, `.${randomUUID()}.claude-capability.tmp`);
  const bytes = Buffer.from(`${canonicalJson(state)}\n`, 'utf8');
  let handle;
  let published = false;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await writeImpl(handle, bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await beforeRename({ pathname, temporary });
    await renameImpl(temporary, pathname);
    published = true;
    const directoryHandle = await open(parent, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    const readback = await readClaudeCapabilityState(pathname);
    if (!readback.ok || !sameValue(readback.state, state)) {
      throw new ClaudeCapabilityError(
        'CLAUDE_CAPABILITY_READBACK_FAILED',
        'published capability state did not read back byte-equivalent and valid',
        readback.reasons,
      );
    }
    return { pathname, state: readback.state };
  } finally {
    if (handle) await handle.close();
    if (!published) await rm(temporary, { force: true });
  }
}
