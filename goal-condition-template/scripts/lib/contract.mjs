import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { TextDecoder } from 'node:util';

// This is a deliberately narrow, deterministic validator for this repository's
// run contract. It is not a general JSON Schema Draft validator.
export const CONTRACT_FIELD_TABLES = Object.freeze({
  topLevel: Object.freeze([
    'version', 'runtime', 'objective', 'context_sources', 'target_roots',
    'judgment_criteria', 'success_criteria', 'constraints', 'allowed_mutations',
    'budget', 'preflight', 'postflight',
  ]),
  contextSource: Object.freeze(['id', 'path', 'sha256']),
  judgmentCriterion: Object.freeze(['id', 'rule', 'why']),
  successCriterion: Object.freeze(['id', 'command', 'expected']),
  constraint: Object.freeze(['id', 'rule', 'enforcement', 'mechanism', 'verify']),
  allowedMutations: Object.freeze(['files', 'git', 'external']),
  budget: Object.freeze(['user_provided', 'max_turns', 'max_minutes', 'max_tokens', 'max_cost_usd']),
  gitPreflight: Object.freeze(['id', 'type', 'target', 'require_branch', 'require_clean', 'require_upstream']),
  pathPreflight: Object.freeze(['id', 'type', 'target', 'require']),
  command: Object.freeze(['id', 'type', 'cwd', 'argv', 'requires_env', 'capture']),
});

const REQUIRED_TOP_LEVEL = CONTRACT_FIELD_TABLES.topLevel.filter((field) => field !== 'budget');
const TEMPORARY_PATH = /^(?:\/private)?\/tmp(?:\/|$)|^(?:\/private)?\/var\/folders(?:\/|$)/;

// 「这条路径落在临时目录里吗」的唯一真值源。导出是因为 launch 前置闸要问同一个问题（codex 侧的
// state 目录不得落在执行体可写面内，而实测沙箱块的 excludeSlashTmp/excludeTmpdirEnvVar 都是
// false，即 /tmp 与 $TMPDIR 都在执行体可写面内）。两处各写一份正则，就会有一处先漂。
export function isTemporaryPath(value) {
  return typeof value === 'string' && TEMPORARY_PATH.test(normalize(value));
}
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

export class ContractArtifactError extends Error {
  constructor({ code, path, observed: actual, expected, next }) {
    super(`${code} ${path}`);
    this.name = 'ContractArtifactError';
    this.code = code;
    this.path = path;
    this.observed = actual;
    this.expected = expected;
    this.next = next;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeFingerprintValue(value) {
  if (Array.isArray(value)) return value.map(safeFingerprintValue);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, safeFingerprintValue(value[key])]));
  }
  if (value === undefined) return { type: 'undefined' };
  if (typeof value === 'bigint') return { type: 'bigint' };
  if (typeof value === 'symbol') return { type: 'symbol' };
  if (typeof value === 'function') return { type: 'function' };
  return value;
}

function observed(value) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  let serialized;
  try {
    serialized = JSON.stringify(safeFingerprintValue(value));
  } catch {
    serialized = JSON.stringify({ type });
  }
  const bytes = Buffer.from(serialized ?? JSON.stringify({ type }), 'utf8');
  const length = typeof value === 'string' || Array.isArray(value)
    ? value.length
    : isObject(value) ? Object.keys(value).length : 1;
  return `type=${type} length=${length} bytes=${bytes.length} sha256=${createHash('sha256').update(bytes).digest('hex')}`;
}

function diagnostic(code, path, actual, expected, next) {
  return { code, path, observed: observed(actual), expected, next };
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function absolutePath(value) {
  return nonEmptyString(value) && isAbsolute(normalize(value));
}

function addUnknownFields(diagnostics, value, allowed, path) {
  if (!isObject(value)) return;
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  unknown.forEach((key, index) => {
    if (!allowed.includes(key)) {
      diagnostics.push(diagnostic(
        'UNKNOWN_FIELD', path ? `${path}.unknown_fields[${index}]` : `unknown_fields[${index}]`, { key, value: value[key] },
        'a declared field for this contract entry', 'remove the undeclared field',
      ));
    }
  });
}

function requireString(diagnostics, value, path, expectation = 'non-empty string') {
  if (!nonEmptyString(value)) {
    diagnostics.push(diagnostic('STRING_REQUIRED', path, value, expectation, 'supply a non-empty string'));
  }
}

function requireAbsolutePath(diagnostics, value, path, code = 'ABSOLUTE_PATH_REQUIRED') {
  if (!absolutePath(value)) {
    diagnostics.push(diagnostic(code, path, value, 'absolute non-empty path', 'supply an absolute path'));
  }
}

function normalizePolicyPath(diagnostics, value, path) {
  if (typeof value !== 'string') return value;
  const normalized = normalize(value);
  if (normalized !== value) {
    diagnostics.push(diagnostic(
      'PATH_NORMALIZATION_REQUIRED', path, value, 'lexically normalized absolute path',
      'replace dot segments and repeated separators with the normalized stable path',
    ));
  }
  return normalized;
}

function requireArray(diagnostics, value, path, minItems = 0) {
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic('ARRAY_REQUIRED', path, value, 'array', 'supply an array'));
    return false;
  }
  if (value.length < minItems) {
    diagnostics.push(diagnostic('MIN_ITEMS', path, value.length, `array with at least ${minItems} item(s)`, 'add the required entry'));
  }
  return true;
}

function rejectTemporaryPath(diagnostics, value, path, code) {
  if (!isTemporaryPath(value)) return;
  diagnostics.push(diagnostic(
    code, path, value, 'stable non-temporary absolute path',
    'store the contract input outside temporary directories before compiling the contract',
  ));
}

function validatePathArray(diagnostics, value, path, { temporaryCode, minItems = 0 } = {}) {
  if (!requireArray(diagnostics, value, path, minItems)) return;
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const normalized = normalizePolicyPath(diagnostics, entry, entryPath);
    requireAbsolutePath(diagnostics, normalized, entryPath);
    if (temporaryCode) rejectTemporaryPath(diagnostics, normalized, entryPath, temporaryCode);
  });
}

function validateContextSources(diagnostics, value, ids) {
  if (!requireArray(diagnostics, value, 'context_sources')) return;
  value.forEach((entry, index) => {
    const path = `context_sources[${index}]`;
    if (!isObject(entry)) {
      diagnostics.push(diagnostic('OBJECT_REQUIRED', path, entry, 'context source object', 'supply id, path, and sha256'));
      return;
    }
    addUnknownFields(diagnostics, entry, CONTRACT_FIELD_TABLES.contextSource, path);
    validateId(diagnostics, entry, path, ids);
    const normalized = normalizePolicyPath(diagnostics, entry.path, `${path}.path`);
    requireAbsolutePath(diagnostics, normalized, `${path}.path`);
    rejectTemporaryPath(diagnostics, normalized, `${path}.path`, 'TEMP_CONTEXT');
    if (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) {
      diagnostics.push(diagnostic(
        'CONTEXT_SHA256_INVALID', `${path}.sha256`, entry.sha256, 'lowercase 64-character SHA-256 hex',
        'hash the exact context bytes and supply the lowercase digest',
      ));
    }
  });
}

function validateId(diagnostics, entry, path, ids) {
  requireString(diagnostics, entry.id, `${path}.id`);
  if (nonEmptyString(entry.id)) {
    if (ids.has(entry.id)) {
      diagnostics.push(diagnostic('DUPLICATE_ID', `${path}.id`, entry.id, 'unique entry id', 'assign a unique id'));
    }
    ids.add(entry.id);
  }
}

function validateCriteria(diagnostics, value, path, fields, ids) {
  if (!requireArray(diagnostics, value, path, 1)) return;
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isObject(entry)) {
      diagnostics.push(diagnostic('OBJECT_REQUIRED', entryPath, entry, 'object', 'supply a criterion object'));
      return;
    }
    addUnknownFields(diagnostics, entry, CONTRACT_FIELD_TABLES[fields], entryPath);
    validateId(diagnostics, entry, entryPath, ids);
    for (const field of CONTRACT_FIELD_TABLES[fields].filter((field) => field !== 'id')) {
      requireString(diagnostics, entry[field], `${entryPath}.${field}`);
    }
  });
}

function validateConstraints(diagnostics, value, ids) {
  if (!requireArray(diagnostics, value, 'constraints')) return;
  value.forEach((entry, index) => {
    const path = `constraints[${index}]`;
    if (!isObject(entry)) {
      diagnostics.push(diagnostic('OBJECT_REQUIRED', path, entry, 'object', 'supply a constraint object'));
      return;
    }
    addUnknownFields(diagnostics, entry, CONTRACT_FIELD_TABLES.constraint, path);
    validateId(diagnostics, entry, path, ids);
    requireString(diagnostics, entry.rule, `${path}.rule`);
    if (!['physical', 'audit_only'].includes(entry.enforcement)) {
      diagnostics.push(diagnostic('CONSTRAINT_ENFORCEMENT_INVALID', `${path}.enforcement`, entry.enforcement, 'physical or audit_only', 'select a supported enforcement mode'));
    }
    for (const field of ['mechanism', 'verify']) {
      if (entry[field] !== undefined && typeof entry[field] !== 'string') {
        diagnostics.push(diagnostic('STRING_REQUIRED', `${path}.${field}`, entry[field], 'string when provided', 'supply a string or omit the field'));
      }
    }
    if (entry.enforcement === 'physical') {
      if (!nonEmptyString(entry.mechanism)) {
        diagnostics.push(diagnostic(
          'CONSTRAINT_MECHANISM_REQUIRED', `${path}.mechanism`, entry.mechanism,
          'non-empty string when enforcement=physical',
          'supply an executable mechanism or mark the constraint audit_only',
        ));
      }
      if (!nonEmptyString(entry.verify)) {
        diagnostics.push(diagnostic(
          'CONSTRAINT_VERIFY_REQUIRED', `${path}.verify`, entry.verify,
          'non-empty string when enforcement=physical',
          'supply a verifier or mark the constraint audit_only',
        ));
      }
    }
  });
}

function validateAllowedMutations(diagnostics, value) {
  const path = 'allowed_mutations';
  if (!isObject(value)) {
    diagnostics.push(diagnostic('OBJECT_REQUIRED', path, value, 'object', 'supply files, git, and external arrays'));
    return;
  }
  addUnknownFields(diagnostics, value, CONTRACT_FIELD_TABLES.allowedMutations, path);
  for (const field of CONTRACT_FIELD_TABLES.allowedMutations) {
    if (!requireArray(diagnostics, value[field], `${path}.${field}`)) continue;
    value[field].forEach((entry, index) => {
      const entryPath = `${path}.${field}[${index}]`;
      requireString(diagnostics, entry, entryPath);
      if (field === 'files' && typeof entry === 'string') {
        const suffix = entry.endsWith('/**') ? '/**' : '';
        const base = suffix ? entry.slice(0, -3) : entry;
        const normalized = normalizePolicyPath(diagnostics, base, entryPath);
        requireAbsolutePath(diagnostics, normalized, entryPath);
        rejectTemporaryPath(diagnostics, normalized, entryPath, 'TEMP_PATH');
      }
    });
  }
}

function validateBudget(diagnostics, value) {
  if (value === undefined) return;
  const path = 'budget';
  if (!isObject(value)) {
    diagnostics.push(diagnostic('OBJECT_REQUIRED', path, value, 'object', 'supply a budget object or omit budget'));
    return;
  }
  addUnknownFields(diagnostics, value, CONTRACT_FIELD_TABLES.budget, path);
  if (value.user_provided !== true) {
    diagnostics.push(diagnostic('BUDGET_PROVENANCE_REQUIRED', `${path}.user_provided`, value.user_provided, 'true when budget is present', 'set user_provided to true only for an explicit user budget'));
  }
  const limits = ['max_turns', 'max_minutes', 'max_tokens', 'max_cost_usd'];
  if (!limits.some((field) => value[field] !== undefined)) {
    diagnostics.push(diagnostic('BUDGET_LIMIT_REQUIRED', path, value, 'at least one explicit budget limit', 'supply one supported budget limit'));
  }
  for (const field of limits) {
    const limit = value[field];
    if (limit === undefined) continue;
    if (!(typeof limit === 'number' && Number.isFinite(limit) && limit > 0)) {
      diagnostics.push(diagnostic('POSITIVE_NUMBER_REQUIRED', `${path}.${field}`, limit, 'positive finite number', 'supply a positive numeric limit'));
      continue;
    }
    // max_turns 是轮数，小数没有可执行语义：0.5 会同时把 CLI 的 --max-turns 与 Stop hook 的
    // maxBlocks floor 成 0，两处一起退化成「什么都不做」。在这里拒是唯一不撒谎的处置——
    // 消费端补 Math.max(1, …) 等于凭空发明一个用户没给的预算。分钟与费用允许小数，不设此闸。
    if (field === 'max_turns' && !Number.isInteger(limit)) {
      diagnostics.push(diagnostic(
        'BUDGET_TURNS_INTEGER_REQUIRED', `${path}.${field}`, limit, 'whole number of turns',
        'supply an integer max_turns',
      ));
    }
  }
}

function validateCommandEntry(diagnostics, entry, path, ids) {
  addUnknownFields(diagnostics, entry, CONTRACT_FIELD_TABLES.command, path);
  validateId(diagnostics, entry, path, ids);
  const normalizedCwd = normalizePolicyPath(diagnostics, entry.cwd, `${path}.cwd`);
  requireAbsolutePath(diagnostics, normalizedCwd, `${path}.cwd`);
  rejectTemporaryPath(diagnostics, normalizedCwd, `${path}.cwd`, 'TEMP_PATH');
  if (!requireArray(diagnostics, entry.argv, `${path}.argv`, 1)) {
    // The missing argv diagnostic is sufficient; do not inspect an absent value.
  } else {
    entry.argv.forEach((part, index) => requireString(diagnostics, part, `${path}.argv[${index}]`));
  }
  if (entry.requires_env !== undefined) {
    if (requireArray(diagnostics, entry.requires_env, `${path}.requires_env`)) {
      entry.requires_env.forEach((name, index) => {
        if (!(typeof name === 'string' && ENV_NAME.test(name))) {
          diagnostics.push(diagnostic('ENV_NAME_INVALID', `${path}.requires_env[${index}]`, name, 'environment variable name', 'use [A-Za-z_][A-Za-z0-9_]*'));
        }
      });
    }
  }
  if (entry.capture !== undefined && !['hash', 'text'].includes(entry.capture)) {
    diagnostics.push(diagnostic('CAPTURE_INVALID', `${path}.capture`, entry.capture, 'hash or text', 'select a supported capture mode'));
  }
}

function validatePreflight(diagnostics, value, ids) {
  if (!requireArray(diagnostics, value, 'preflight', 1)) return;
  value.forEach((entry, index) => {
    const path = `preflight[${index}]`;
    if (!isObject(entry)) {
      diagnostics.push(diagnostic('OBJECT_REQUIRED', path, entry, 'object', 'supply a preflight object'));
      return;
    }
    if (entry.type === 'command') {
      validateCommandEntry(diagnostics, entry, path, ids);
      return;
    }
    if (entry.type === 'git') {
      addUnknownFields(diagnostics, entry, CONTRACT_FIELD_TABLES.gitPreflight, path);
      validateId(diagnostics, entry, path, ids);
      const normalizedTarget = normalizePolicyPath(diagnostics, entry.target, `${path}.target`);
      requireAbsolutePath(diagnostics, normalizedTarget, `${path}.target`);
      rejectTemporaryPath(diagnostics, normalizedTarget, `${path}.target`, 'TEMP_PATH');
      if (entry.require_branch !== undefined) requireString(diagnostics, entry.require_branch, `${path}.require_branch`);
      for (const field of ['require_clean', 'require_upstream']) {
        if (entry[field] !== undefined && typeof entry[field] !== 'boolean') {
          diagnostics.push(diagnostic('BOOLEAN_REQUIRED', `${path}.${field}`, entry[field], 'boolean when provided', 'supply true or false'));
        }
      }
      return;
    }
    if (entry.type === 'path') {
      addUnknownFields(diagnostics, entry, CONTRACT_FIELD_TABLES.pathPreflight, path);
      validateId(diagnostics, entry, path, ids);
      const normalizedTarget = normalizePolicyPath(diagnostics, entry.target, `${path}.target`);
      requireAbsolutePath(diagnostics, normalizedTarget, `${path}.target`);
      rejectTemporaryPath(diagnostics, normalizedTarget, `${path}.target`, 'TEMP_PATH');
      if (!['file', 'directory', 'exists'].includes(entry.require)) {
        diagnostics.push(diagnostic('PATH_REQUIRE_INVALID', `${path}.require`, entry.require, 'file, directory, or exists', 'select a supported path requirement'));
      }
      return;
    }
    diagnostics.push(diagnostic('PREFLIGHT_TYPE_INVALID', `${path}.type`, entry.type, 'git, path, or command', 'select a supported preflight type'));
  });
}

function validatePostflight(diagnostics, value, ids) {
  if (!requireArray(diagnostics, value, 'postflight', 1)) return;
  value.forEach((entry, index) => {
    const path = `postflight[${index}]`;
    if (!isObject(entry)) {
      diagnostics.push(diagnostic('OBJECT_REQUIRED', path, entry, 'command object', 'supply a command verifier'));
      return;
    }
    if (entry.type !== 'command') {
      diagnostics.push(diagnostic('POSTFLIGHT_TYPE_INVALID', `${path}.type`, entry.type, 'command', 'postflight accepts only independent command verifiers'));
      return;
    }
    validateCommandEntry(diagnostics, entry, path, ids);
  });
}

export function validateContract(value) {
  const diagnostics = [];
  if (!isObject(value)) {
    return [diagnostic('CONTRACT_OBJECT_REQUIRED', '', value, 'contract object', 'supply a JSON object')];
  }
  addUnknownFields(diagnostics, value, CONTRACT_FIELD_TABLES.topLevel, '');
  for (const field of REQUIRED_TOP_LEVEL) {
    if (value[field] === undefined) {
      diagnostics.push(diagnostic('REQUIRED_FIELD', field, undefined, 'required contract field', 'supply the required field'));
    }
  }
  if (value.version !== 1) {
    diagnostics.push(diagnostic('VERSION_INVALID', 'version', value.version, '1', 'set version to 1'));
  }
  if (!['claude', 'codex'].includes(value.runtime)) {
    diagnostics.push(diagnostic('RUNTIME_INVALID', 'runtime', value.runtime, 'claude or codex', 'select one supported runtime'));
  }
  requireString(diagnostics, value.objective, 'objective');
  const entryIds = new Set();
  validateContextSources(diagnostics, value.context_sources, entryIds);
  validatePathArray(diagnostics, value.target_roots, 'target_roots', { temporaryCode: 'TEMP_PATH', minItems: 1 });
  validateCriteria(diagnostics, value.judgment_criteria, 'judgment_criteria', 'judgmentCriterion', entryIds);
  validateCriteria(diagnostics, value.success_criteria, 'success_criteria', 'successCriterion', entryIds);
  validateConstraints(diagnostics, value.constraints, entryIds);
  validateAllowedMutations(diagnostics, value.allowed_mutations);
  validateBudget(diagnostics, value.budget);
  validatePreflight(diagnostics, value.preflight, entryIds);
  validatePostflight(diagnostics, value.postflight, entryIds);
  return diagnostics;
}

function sortForCanonicalJson(value) {
  if (Array.isArray(value)) return value.map(sortForCanonicalJson);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortForCanonicalJson(value[key])]));
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortForCanonicalJson(value))}\n`;
}

function rawByteEvidence(raw) {
  return `sha256=${createHash('sha256').update(raw).digest('hex')} bytes=${raw.length}`;
}

function contractByteError(raw, code, expected, next) {
  return new ContractArtifactError({
    code,
    path: 'contract_bytes',
    observed: rawByteEvidence(raw),
    expected,
    next,
  });
}

export async function readContract(filePath) {
  const raw = await readFile(filePath);
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    throw contractByteError(
      raw,
      'CONTRACT_BOM_FORBIDDEN',
      'UTF-8 JSON bytes without a byte-order mark',
      'remove the BOM, regenerate canonical JSON, and validate it again',
    );
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw contractByteError(
      raw,
      'CONTRACT_UTF8_INVALID',
      'well-formed UTF-8 JSON bytes',
      'regenerate the contract as strict UTF-8 canonical JSON and validate it again',
    );
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw contractByteError(
      raw,
      'CONTRACT_JSON_INVALID',
      'valid JSON encoded as UTF-8',
      'regenerate the contract as canonical JSON and validate it again',
    );
  }
  const canonical = Buffer.from(canonicalJson(value), 'utf8');
  if (!raw.equals(canonical)) {
    throw contractByteError(
      raw,
      'CONTRACT_BYTES_NONCANONICAL',
      'bytes identical to canonicalJson(parsed contract)',
      'rewrite the file with canonicalJson, then revalidate, repreview, and reconfirm its hash',
    );
  }
  return value;
}

export function contractHash(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function previewRows(entries, formatter) {
  if (!Array.isArray(entries) || entries.length === 0) return '- none';
  return entries.map((entry, index) => `- ${formatter(entry, index)}`).join('\n');
}

export function renderPreview(value) {
  const hash = contractHash(value);
  const canonical = canonicalJson(value);
  const allowed = value?.allowed_mutations ?? {};
  return [
    `Contract SHA-256: ${hash}`,
    'Objective:',
    String(value?.objective ?? ''),
    '',
    'Judgment criteria:',
    previewRows(value?.judgment_criteria, (entry) => `[${entry?.id ?? '?'}] ${entry?.rule ?? ''} — why: ${entry?.why ?? ''}`),
    '',
    'Constraint matrix:',
    previewRows(value?.constraints, (entry) => `[${entry?.id ?? '?'}] ${entry?.enforcement ?? ''} | rule: ${entry?.rule ?? ''} | mechanism: ${entry?.mechanism ?? ''} | verify: ${entry?.verify ?? ''}`),
    '',
    'Allowed mutations matrix:',
    ...['files', 'git', 'external'].map((kind) => `- ${kind}: ${Array.isArray(allowed[kind]) ? allowed[kind].join(', ') || 'none' : 'invalid'}`),
    '',
    'Acceptance criteria:',
    previewRows(value?.success_criteria, (entry) => `[${entry?.id ?? '?'}] ${entry?.command ?? ''} => ${entry?.expected ?? ''}`),
    '',
    'Preflight:',
    previewRows(value?.preflight, (entry) => `[${entry?.id ?? '?'}] ${entry?.type ?? ''}`),
    'Postflight:',
    previewRows(value?.postflight, (entry) => `[${entry?.id ?? '?'}] argv: ${Array.isArray(entry?.argv) ? entry.argv.join(' ') : ''}`),
    '',
    'Authoritative canonical JSON:',
    canonical,
    `Contract SHA-256: ${hash}`,
  ].join('\n');
}
