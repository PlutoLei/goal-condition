import { createHash } from 'node:crypto';

import { digestCanonical, exactFields } from './values.mjs';

const ID = /^[a-z0-9][a-z0-9-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RECORD_FIELDS = Object.freeze([
  'evidenceId',
  'condition',
  'attemptId',
  'inputHashes',
  'result',
  'outputBytes',
  'capturedAt',
  'expiresAt',
  'controllerOwned',
]);
const STORED_RECORD_FIELDS = Object.freeze([
  'evidence_id', 'condition_id', 'verifier_id', 'verifier_version_hash', 'attempt_id',
  'input_hashes', 'result', 'output_hash', 'captured_at', 'expires_at', 'controller_owned',
]);
const INPUT_FIELDS = Object.freeze(['kind', 'id', 'sha256']);
const INPUT_KINDS = new Set([
  'root_baseline',
  'context',
  'artifact',
  'runtime',
  'boundary',
  'snapshot',
  'preflight',
  'authority',
  'projection',
]);

function evidenceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function timestamp(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw evidenceError('EVIDENCE_TIME_INVALID', `${field} is invalid`);
  return parsed.toISOString();
}

function validateInputs(inputs) {
  if (!Array.isArray(inputs)) throw evidenceError('EVIDENCE_INPUTS_INVALID', 'inputHashes must be an array');
  const keys = new Set();
  return inputs.map((input) => {
    exactFields(input, INPUT_FIELDS, 'input_hash');
    if (!INPUT_KINDS.has(input.kind)
      || typeof input.id !== 'string'
      || input.id.length === 0
      || typeof input.sha256 !== 'string'
      || !SHA256.test(input.sha256)) {
      throw evidenceError('EVIDENCE_INPUT_INVALID', 'each input hash must be a typed content binding');
    }
    const key = `${input.kind}:${input.id}`;
    if (keys.has(key)) throw evidenceError('EVIDENCE_INPUT_DUPLICATE', `duplicate input binding ${key}`);
    keys.add(key);
    return structuredClone(input);
  });
}

function outputHash(bytes) {
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  return createHash('sha256').update(content).digest('hex');
}

export function recordEvidence(args) {
  exactFields(args, RECORD_FIELDS, 'evidence_input');
  const {
    evidenceId,
    condition,
    attemptId,
    inputHashes,
    result,
    outputBytes,
    capturedAt,
    expiresAt = null,
    controllerOwned,
  } = args;
  if (typeof evidenceId !== 'string' || !ID.test(evidenceId)) {
    throw evidenceError('EVIDENCE_ID_INVALID', 'evidenceId must be stable kebab-case');
  }
  if (typeof condition?.id !== 'string' || typeof condition?.verifier?.id !== 'string') {
    throw evidenceError('CONDITION_INVALID', 'evidence requires a Condition with a verifier');
  }
  if (typeof attemptId !== 'string' || !ID.test(attemptId)) {
    throw evidenceError('ATTEMPT_ID_INVALID', 'attemptId must be stable kebab-case');
  }
  if (!['pass', 'fail', 'error'].includes(result)) {
    throw evidenceError('EVIDENCE_RESULT_INVALID', 'result must be pass, fail, or error');
  }
  if (typeof controllerOwned !== 'boolean') {
    throw evidenceError('CONTROLLER_OWNERSHIP_REQUIRED', 'controllerOwned must be explicit');
  }
  return {
    evidence_id: evidenceId,
    condition_id: condition.id,
    verifier_id: condition.verifier.id,
    verifier_version_hash: digestCanonical(condition.verifier),
    attempt_id: attemptId,
    input_hashes: validateInputs(inputHashes),
    result,
    output_hash: outputHash(outputBytes),
    captured_at: timestamp(capturedAt, 'capturedAt'),
    expires_at: timestamp(expiresAt, 'expiresAt', { nullable: true }),
    controller_owned: controllerOwned,
  };
}

export function validateEvidenceRecord(record) {
  exactFields(record, STORED_RECORD_FIELDS, 'evidence_record');
  for (const field of ['evidence_id', 'condition_id', 'verifier_id', 'attempt_id']) {
    if (typeof record[field] !== 'string' || !ID.test(record[field])) {
      throw evidenceError('EVIDENCE_ID_INVALID', `${field} must be stable kebab-case`);
    }
  }
  for (const field of ['verifier_version_hash', 'output_hash']) {
    if (typeof record[field] !== 'string' || !SHA256.test(record[field])) {
      throw evidenceError('EVIDENCE_HASH_INVALID', `${field} must be lowercase SHA-256`);
    }
  }
  validateInputs(record.input_hashes);
  if (!['pass', 'fail', 'error'].includes(record.result)) {
    throw evidenceError('EVIDENCE_RESULT_INVALID', 'stored evidence result is invalid');
  }
  timestamp(record.captured_at, 'captured_at');
  timestamp(record.expires_at, 'expires_at', { nullable: true });
  if (typeof record.controller_owned !== 'boolean') {
    throw evidenceError('CONTROLLER_OWNERSHIP_REQUIRED', 'stored evidence ownership must be explicit');
  }
  return true;
}

function bindingMap(bindings) {
  const map = new Map();
  for (const binding of bindings) map.set(`${binding.kind}:${binding.id}`, binding.sha256);
  return map;
}

function inputBindingsMatch(evidenceInputs, currentInputs) {
  let evidenceMap;
  let currentMap;
  try {
    evidenceMap = bindingMap(validateInputs(evidenceInputs));
    currentMap = bindingMap(validateInputs(currentInputs));
  } catch {
    return false;
  }
  if (evidenceMap.size !== currentMap.size) return false;
  for (const [key, hash] of evidenceMap) {
    if (currentMap.get(key) !== hash) return false;
  }
  return true;
}

export function evaluateConditionEvidence({ condition, evidence, currentInputs, now = new Date() }) {
  const reasons = new Set();
  const currentVerifierHash = digestCanonical(condition.verifier);
  const nowMs = new Date(now).getTime();
  if (Number.isNaN(nowMs)) throw evidenceError('EVIDENCE_TIME_INVALID', 'now is invalid');
  let selected = null;
  for (const item of evidence) {
    if (item?.condition_id !== condition.id) continue;
    if (item.controller_owned !== true) {
      reasons.add('CONTROLLER_EVIDENCE_MISSING');
      continue;
    }
    if (item.verifier_id !== condition.verifier.id
      || item.verifier_version_hash !== currentVerifierHash) {
      reasons.add('VERIFIER_VERSION_MISMATCH');
      continue;
    }
    if (item.result !== 'pass') {
      reasons.add('EVIDENCE_NOT_PASSING');
      continue;
    }
    if (!inputBindingsMatch(item.input_hashes, currentInputs)) {
      reasons.add('INPUT_HASH_MISMATCH');
      continue;
    }
    if (item.expires_at !== null && new Date(item.expires_at).getTime() <= nowMs) {
      reasons.add('EVIDENCE_EXPIRED');
      continue;
    }
    selected = item;
    break;
  }
  if (selected === null && reasons.size === 0) reasons.add('CONTROLLER_EVIDENCE_MISSING');
  return {
    satisfied: selected !== null,
    evidence_id: selected?.evidence_id ?? null,
    reason_codes: selected === null ? [...reasons].sort() : [],
  };
}

function invalidationPredicate(change) {
  if (change.type === 'REFRESH_CONTEXT') {
    return (item) => item.input_hashes?.some(
      (input) => input.kind === 'context' && input.id === change.dependency_id,
    );
  }
  if (change.type === 'REPLACE_EQUIVALENT_VERIFIER') {
    return (item) => item.condition_id === change.condition_id || item.verifier_id === change.verifier_id;
  }
  if (change.type === 'EXPAND_WITHIN_AUTHORITY') {
    const impacted = new Set(change.impacted_condition_ids ?? []);
    return (item) => impacted.has(item.condition_id);
  }
  if (change.type === 'ARTIFACT_CHANGED') {
    return (item) => item.input_hashes?.some(
      (input) => input.kind === 'artifact' && input.id === change.dependency_id,
    );
  }
  if (change.type === 'RUNTIME_VERSION_CHANGED') {
    return (item) => item.input_hashes?.some(
      (input) => input.kind === 'runtime' && input.id === change.dependency_id,
    );
  }
  return () => false;
}

export function invalidateForRevision({ evidence, change, rootBaselineHash }) {
  const invalidatedResources = [];
  const invalidatedConditionIds = [];
  let requiresPreflight = false;
  if (change.type === 'ADD_CONDITION') invalidatedConditionIds.push(change.condition_id);
  if (change.type === 'EXPAND_WITHIN_AUTHORITY') {
    invalidatedResources.push('attempt_snapshot', 'preflight');
    invalidatedConditionIds.push(...(change.impacted_condition_ids ?? []));
    requiresPreflight = true;
  }
  if (change.type === 'CONTROLLER_CORRECTION' && change.scope === 'projection_only') {
    invalidatedResources.push('attempt', 'projection_proof');
  }
  if (change.type === 'EXPAND_AUTHORITY') {
    invalidatedResources.push('preflight');
    requiresPreflight = true;
  }
  const shouldInvalidate = invalidationPredicate(change);
  const invalidated = evidence.filter(shouldInvalidate).map((item) => item.evidence_id).sort();
  const invalidatedSet = new Set(invalidated);
  const preserved = evidence
    .filter((item) => !invalidatedSet.has(item.evidence_id))
    .map((item) => item.evidence_id)
    .sort();
  return {
    invalidated_evidence_ids: invalidated,
    invalidated_condition_ids: [...new Set(invalidatedConditionIds)].sort(),
    invalidated_resources: invalidatedResources,
    preserved_evidence_ids: preserved,
    requires_preflight: requiresPreflight,
    root_baseline_hash: rootBaselineHash,
    root_baseline_preserved: true,
  };
}

function sessionInputs(session) {
  const design = session.design_revisions.at(-1);
  return [
    { kind: 'root_baseline', id: session.session_id, sha256: session.root_baseline_hash },
    ...design.context_dependencies.map((dependency) => ({
      kind: 'context',
      id: dependency.id,
      sha256: dependency.sha256,
    })),
  ];
}

export function completionLevel({
  session,
  evidence,
  bypasses,
  currentInputsByCondition = {},
  now = new Date(),
}) {
  const conditions = session.design_revisions.at(-1).conditions;
  const evaluations = conditions.map((condition) => ({
    condition_id: condition.id,
    ...evaluateConditionEvidence({
      condition,
      evidence,
      currentInputs: [
        ...sessionInputs(session),
        ...(currentInputsByCondition[condition.id] ?? []),
      ],
      now,
    }),
  }));
  const missing = evaluations.filter((evaluation) => !evaluation.satisfied);
  if (missing.length > 0) {
    return {
      level: 'candidate',
      reason_codes: [
        'CONTROLLER_EVIDENCE_MISSING',
        ...new Set(missing.flatMap((evaluation) => evaluation.reason_codes)),
      ],
      conditions: evaluations,
    };
  }
  if (bypasses.length > 0) {
    return {
      level: 'verified',
      reason_codes: ['CONTROL_PLANE_BYPASS'],
      conditions: evaluations,
    };
  }
  return {
    level: 'certified',
    reason_codes: ['ALL_CONDITIONS_CERTIFIED'],
    conditions: evaluations,
  };
}
