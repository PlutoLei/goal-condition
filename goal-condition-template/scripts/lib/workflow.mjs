function action(actionName, reasons = []) {
  return { action: actionName, reasons: Array.isArray(reasons) ? reasons : [reasons] };
}

function reject(reasons) {
  return action('reject', reasons);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectShapeReasons(name, value, fields) {
  if (!isObject(value)) return [`${name} must be an object`];
  const reasons = [];
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) reasons.push(`${name}.${field} is required`);
  }
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) reasons.push(`${name} contains an unknown field`);
  }
  return reasons;
}

function gateState(name, gate) {
  if (!isObject(gate)) return { ok: false, reasons: [`${name} must be an object`] };
  if (typeof gate.ok !== 'boolean') return { ok: false, reasons: [`${name}.ok must be a boolean`] };
  if (!Array.isArray(gate.reasons)) return { ok: false, reasons: [`${name}.reasons must be an array`] };
  if (gate.reasons.some((reason) => typeof reason !== 'string' || reason.trim().length === 0)) {
    return { ok: false, reasons: [`${name}.reasons must contain non-empty strings`] };
  }
  if (gate.ok && gate.reasons.length > 0) {
    return { ok: false, reasons: [`${name}.reasons must be empty when ok=true`] };
  }
  if (!gate.ok && gate.reasons.length === 0) {
    return { ok: false, reasons: [`${name} failed without reasons`] };
  }
  return { ok: gate.ok, reasons: gate.ok ? [] : Array.from(gate.reasons) };
}

function claudeTerminalState(result) {
  const reasons = objectShapeReasons(
    'Claude result', result, ['subtype', 'is_error', 'terminal_reason', 'permission_denials'],
  );
  if (!isObject(result)) return { ok: false, reasons };
  if (result.subtype !== 'success') reasons.push('Claude subtype must be success');
  if (result.is_error !== false) reasons.push('Claude reported an error');
  if (result.terminal_reason !== 'completed') reasons.push('Claude terminal_reason must be completed');
  if (!Array.isArray(result.permission_denials) || result.permission_denials.length > 0) {
    reasons.push('Claude has permission denials');
  }
  return { ok: reasons.length === 0, reasons };
}

function codexTerminalState(result) {
  const reasons = objectShapeReasons('Codex result', result, ['status', 'remaining_work']);
  if (!isObject(result)) return { ok: false, phase: 'invalid', reasons };
  if (result.status !== 'ready_for_postflight') reasons.push('Codex status must be ready_for_postflight');
  if (result.remaining_work !== false) reasons.push('Codex still has remaining_work');
  if (reasons.length) return { ok: false, phase: 'invalid', reasons };
  return { ok: true, phase: 'ready_for_postflight', reasons: [] };
}

export function runtimeTerminalState(runtime, result) {
  if (runtime === 'claude') return claudeTerminalState(result);
  if (runtime === 'codex') return codexTerminalState(result);
  return { ok: false, reasons: ['runtime must be claude or codex'] };
}

const DIGEST = /^[0-9a-f]{64}$/;
const BINDING_FIELDS = Object.freeze(['contractHash', 'baselineDigest', 'runId']);
const CONTROLLER_GATE_FIELDS = Object.freeze(['ok', 'reasons', 'binding']);
const FINALIZATION_FIELDS = Object.freeze(['ok', 'operation', 'status', 'reasons', 'binding']);
const READBACK_FIELDS = Object.freeze([
  'ok', 'source', 'status', 'remaining_work', 'error', 'blocked', 'reasons', 'binding',
]);
const INPUT_FIELDS = Object.freeze([
  'validation', 'contractHash', 'confirmedHash', 'runtime', 'runBinding',
  'preflightEvidence', 'runtimeResult', 'postflightEvidence',
  'finalizationReceipt', 'runtimeReadback',
]);

function bindingState(name, binding, expectedBinding, contractHash) {
  const reasons = objectShapeReasons(name, binding, BINDING_FIELDS);
  if (!isObject(binding)) return { ok: false, reasons };
  if (!DIGEST.test(binding.contractHash ?? '')) reasons.push(`${name}.contractHash must be lowercase SHA-256`);
  if (!DIGEST.test(binding.baselineDigest ?? '')) reasons.push(`${name}.baselineDigest must be lowercase SHA-256`);
  if (typeof binding.runId !== 'string' || binding.runId.length === 0) reasons.push(`${name}.runId must be non-empty`);
  if (binding.contractHash !== contractHash) reasons.push(`${name}.contractHash must match confirmed contractHash`);
  if (expectedBinding && BINDING_FIELDS.some((field) => binding[field] !== expectedBinding[field])) {
    reasons.push(`${name} must match runBinding`);
  }
  return { ok: reasons.length === 0, reasons };
}

function controllerGateState(name, evidence, fields, expectedBinding, contractHash) {
  const reasons = objectShapeReasons(name, evidence, fields);
  if (!isObject(evidence)) return { ok: false, reasons };
  const binding = bindingState(`${name}.binding`, evidence.binding, expectedBinding, contractHash);
  reasons.push(...binding.reasons);
  const gate = gateState(name, evidence);
  if (!gate.ok) reasons.push(...gate.reasons);
  return { ok: reasons.length === 0, reasons };
}

function codexFinalization({ contractHash, runBinding, finalizationReceipt, runtimeReadback }) {
  if (finalizationReceipt === undefined) return action('finalize_runtime');
  const finalization = controllerGateState(
    'finalizationReceipt', finalizationReceipt, FINALIZATION_FIELDS, runBinding, contractHash,
  );
  if (finalizationReceipt?.operation !== 'thread/goal/set') {
    finalization.reasons.push('finalizationReceipt.operation must be thread/goal/set');
  }
  if (finalizationReceipt?.status !== 'complete') {
    finalization.reasons.push('finalizationReceipt.status must be complete');
  }
  if (finalization.reasons.length) return reject(finalization.reasons);
  if (runtimeReadback === undefined) return action('verify_runtime');

  const readback = controllerGateState(
    'runtimeReadback', runtimeReadback, READBACK_FIELDS, runBinding, contractHash,
  );
  if (runtimeReadback?.source !== 'thread/goal/get') readback.reasons.push('runtimeReadback.source must be thread/goal/get');
  if (runtimeReadback?.status !== 'complete') readback.reasons.push('runtimeReadback.status must be complete');
  if (runtimeReadback?.remaining_work !== false) readback.reasons.push('runtimeReadback has remaining_work');
  if (runtimeReadback?.error !== false) readback.reasons.push('runtimeReadback reported an error');
  if (runtimeReadback?.blocked !== false) readback.reasons.push('runtimeReadback reported blocked');
  return readback.reasons.length ? reject(readback.reasons) : action('complete');
}

export function nextAction(input = {}) {
  const inputShape = objectShapeReasons('workflow input', input, INPUT_FIELDS.filter((field) => (
    ['validation', 'contractHash', 'confirmedHash'].includes(field) || Object.hasOwn(input, field)
  )));
  if (!isObject(input) || inputShape.length) return reject(inputShape);
  const {
    validation, contractHash, confirmedHash, runtime, runBinding, preflightEvidence,
    runtimeResult, postflightEvidence, finalizationReceipt, runtimeReadback,
  } = input;
  if (!Array.isArray(validation)) return reject('validation must be an array');
  if (validation.length) return reject(validation);
  if (!DIGEST.test(contractHash ?? '')) return reject('contractHash must be lowercase SHA-256');
  if (confirmedHash !== contractHash) return action('preview', ['confirmation hash mismatch']);

  const laterEvidencePresent = [runtimeResult, postflightEvidence, finalizationReceipt, runtimeReadback]
    .some((value) => value !== undefined);
  if (runBinding === undefined && preflightEvidence === undefined) {
    return laterEvidencePresent ? reject('runtime evidence requires prior controller preflight') : action('preflight');
  }
  if (runBinding === undefined || preflightEvidence === undefined) {
    return reject('runBinding and preflightEvidence must be supplied together');
  }
  const binding = bindingState('runBinding', runBinding, undefined, contractHash);
  if (!binding.ok) return reject(binding.reasons);
  const preflight = controllerGateState(
    'preflightEvidence', preflightEvidence, CONTROLLER_GATE_FIELDS, runBinding, contractHash,
  );
  if (!preflight.ok) return reject(preflight.reasons);
  if (!['claude', 'codex'].includes(runtime)) return reject('runtime must be claude or codex');
  if (runtimeResult === undefined) {
    return postflightEvidence !== undefined || finalizationReceipt !== undefined || runtimeReadback !== undefined
      ? reject('controller postflight evidence requires a runtime candidate') : action('launch');
  }

  const terminal = runtimeTerminalState(runtime, runtimeResult);
  if (!terminal.ok) return reject(terminal.reasons);
  if (finalizationReceipt !== undefined && postflightEvidence === undefined) {
    return reject('finalizationReceipt requires prior postflightEvidence');
  }
  if (runtimeReadback !== undefined && finalizationReceipt === undefined) {
    return reject('runtimeReadback requires prior finalizationReceipt');
  }
  if (postflightEvidence === undefined) return action('postflight');
  const postflight = controllerGateState(
    'postflightEvidence', postflightEvidence, CONTROLLER_GATE_FIELDS, runBinding, contractHash,
  );
  if (!postflight.ok) return reject(postflight.reasons);

  if (runtime === 'claude') {
    if (finalizationReceipt !== undefined || runtimeReadback !== undefined) {
      return reject('Codex finalization evidence is not valid for Claude');
    }
    return action('complete');
  }
  return codexFinalization({ contractHash, runBinding, finalizationReceipt, runtimeReadback });
}
