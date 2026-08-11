import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { canonicalJson } from '../../scripts/lib/contract.mjs';
import { exactFields } from './values.mjs';

const ID = /^[a-z0-9][a-z0-9-]*$/;
const HASH = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32,128}$/;
const INTENT_FIELDS = Object.freeze([
  'intent_version', 'session_id', 'attempt_id', 'design_revision_hash', 'attempt_hash',
  'contract_hash', 'context_package_hash', 'projection_proof_hash', 'workspace_digest',
  'run_id', 'nonce', 'expires_at', 'key_id', 'controller_mac',
]);
const RECEIPT_FIELDS = Object.freeze([
  'receipt_version', 'session_id', 'attempt_id', 'run_id', 'intent_hash', 'thread_id',
  'turn_id', 'started_at',
]);
export const ATTEMPT_FIELDS = Object.freeze([
  'attempt_id', 'status', 'attempt_hash', 'session_id', 'design_revision_hash', 'contract_hash',
  'context_package_hash', 'projection_proof_hash', 'workspace_digest', 'run_id',
  'launch_receipt', 'candidate', 'completion_level', 'bypasses',
]);

function attemptError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireId(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) throw attemptError('ATTEMPT_ID_INVALID', `${field} is invalid`);
}

function requireHash(value, field) {
  if (typeof value !== 'string' || !HASH.test(value)) throw attemptError('ATTEMPT_HASH_INVALID', `${field} is invalid`);
}

function requireTime(value, field) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw attemptError('ATTEMPT_TIME_INVALID', `${field} is invalid`);
  return date.toISOString();
}

function unsignedIntent(intent) {
  const { controller_mac: ignored, ...unsigned } = intent;
  return unsigned;
}

function macFor(key, value) {
  if (!Buffer.isBuffer(key) || key.byteLength !== 32) {
    throw attemptError('CONTROLLER_KEY_INVALID', 'controller key must be 32 bytes');
  }
  return createHmac('sha256', key).update(canonicalJson(value)).digest('hex');
}

export function launchIntentHash(intent) {
  return createHash('sha256').update(canonicalJson(intent)).digest('hex');
}

export function createLaunchIntent({
  sessionId, attemptId, designRevisionHash, attemptHash, contractHash,
  contextPackageHash, projectionProofHash, workspaceDigest, runId, nonce,
  expiresAt, key, keyId, signer,
}) {
  requireId(sessionId, 'sessionId');
  requireId(attemptId, 'attemptId');
  requireId(runId, 'runId');
  for (const [field, value] of [
    ['designRevisionHash', designRevisionHash], ['attemptHash', attemptHash],
    ['contractHash', contractHash], ['contextPackageHash', contextPackageHash],
    ['projectionProofHash', projectionProofHash], ['workspaceDigest', workspaceDigest],
  ]) requireHash(value, field);
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) throw attemptError('ATTEMPT_NONCE_INVALID', 'nonce is invalid');
  requireId(keyId, 'keyId');
  const intent = {
    intent_version: 1,
    session_id: sessionId,
    attempt_id: attemptId,
    design_revision_hash: designRevisionHash,
    attempt_hash: attemptHash,
    contract_hash: contractHash,
    context_package_hash: contextPackageHash,
    projection_proof_hash: projectionProofHash,
    workspace_digest: workspaceDigest,
    run_id: runId,
    nonce,
    expires_at: requireTime(expiresAt, 'expiresAt'),
    key_id: keyId,
  };
  const controllerMac = signer === undefined ? macFor(key, intent) : signer(intent);
  if (typeof controllerMac !== 'string' || !HASH.test(controllerMac)) {
    throw attemptError('CONTROLLER_MAC_INVALID', 'controller signer must return lowercase SHA-256');
  }
  return { ...intent, controller_mac: controllerMac };
}

export function verifyLaunchCapability({ intent, key }) {
  try {
    exactFields(intent, INTENT_FIELDS, 'launch_intent');
    const expected = Buffer.from(macFor(key, unsignedIntent(intent)), 'hex');
    const observed = Buffer.from(intent.controller_mac, 'hex');
    return observed.byteLength === expected.byteLength && timingSafeEqual(observed, expected);
  } catch {
    return false;
  }
}

export function createLaunchReceipt({ intent, threadId, turnId, startedAt }) {
  exactFields(intent, INTENT_FIELDS, 'launch_intent');
  if (typeof threadId !== 'string' || threadId.length === 0
    || typeof turnId !== 'string' || turnId.length === 0) {
    throw attemptError('NATIVE_TURN_REQUIRED', 'a receipt requires native thread and turn ids');
  }
  return {
    receipt_version: 1,
    session_id: intent.session_id,
    attempt_id: intent.attempt_id,
    run_id: intent.run_id,
    intent_hash: launchIntentHash(intent),
    thread_id: threadId,
    turn_id: turnId,
    started_at: requireTime(startedAt, 'startedAt'),
  };
}

export function realizeAttempt({ intent, receipt }) {
  exactFields(intent, INTENT_FIELDS, 'launch_intent');
  exactFields(receipt, RECEIPT_FIELDS, 'launch_receipt');
  if (receipt.session_id !== intent.session_id
    || receipt.attempt_id !== intent.attempt_id
    || receipt.run_id !== intent.run_id
    || receipt.intent_hash !== launchIntentHash(intent)) {
    throw attemptError('LAUNCH_RECEIPT_MISMATCH', 'receipt does not bind this LaunchIntent');
  }
  return {
    attempt_id: intent.attempt_id,
    status: 'Launched',
    attempt_hash: intent.attempt_hash,
    session_id: intent.session_id,
    design_revision_hash: intent.design_revision_hash,
    contract_hash: intent.contract_hash,
    context_package_hash: intent.context_package_hash,
    projection_proof_hash: intent.projection_proof_hash,
    workspace_digest: intent.workspace_digest,
    run_id: intent.run_id,
    launch_receipt: structuredClone(receipt),
    candidate: null,
    completion_level: null,
    bypasses: [],
  };
}

export function validateAttemptRecord(attempt) {
  exactFields(attempt, ATTEMPT_FIELDS, 'attempt');
  requireId(attempt.attempt_id, 'attempt_id');
  requireId(attempt.session_id, 'session_id');
  requireId(attempt.run_id, 'run_id');
  for (const field of [
    'attempt_hash', 'design_revision_hash', 'contract_hash', 'context_package_hash',
    'projection_proof_hash', 'workspace_digest',
  ]) requireHash(attempt[field], field);
  if (!['Launched', 'Candidate', 'Rejected', 'Verified'].includes(attempt.status)) {
    throw attemptError('ATTEMPT_STATUS_INVALID', 'attempt status is invalid');
  }
  exactFields(attempt.launch_receipt, RECEIPT_FIELDS, 'launch_receipt');
  if (!Array.isArray(attempt.bypasses)) throw attemptError('ATTEMPT_BYPASSES_INVALID', 'bypasses must be an array');
  return true;
}
