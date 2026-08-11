import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { canonicalJson } from '../../scripts/lib/contract.mjs';
import { exactFields } from './values.mjs';

const ID = /^[a-z0-9][a-z0-9-]*$/;
const HASH = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32,128}$/;
const INTENT_FIELDS = Object.freeze([
  'intent_version', 'session_id', 'attempt_id', 'design_revision_hash', 'attempt_hash',
  'contract_hash', 'context_package_hash', 'projection_proof_hash', 'workspace_digest',
  'controller_release_digest', 'target_root_identities', 'run_id', 'nonce', 'expires_at',
  'key_id', 'controller_mac',
]);
const RECEIPT_FIELDS = Object.freeze([
  'receipt_version', 'session_id', 'attempt_id', 'run_id', 'intent_hash', 'thread_id',
  'turn_start_response_id', 'turn_input_sha256', 'turn_id', 'authorized_turn_ids', 'started_at',
]);
const CANDIDATE_FIELDS = Object.freeze(['status', 'remaining_work']);
const BYPASS_FIELDS = Object.freeze(['type', 'reason_codes']);
export const ATTEMPT_FIELDS = Object.freeze([
  'attempt_id', 'status', 'attempt_hash', 'session_id', 'design_revision_hash', 'contract_hash',
  'context_package_hash', 'projection_proof_hash', 'workspace_digest', 'run_id',
  'controller_release_digest', 'launch_receipt', 'candidate', 'completion_level', 'bypasses',
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
  controllerReleaseDigest, targetRootIdentities, expiresAt, key, keyId, signer,
}) {
  requireId(sessionId, 'sessionId');
  requireId(attemptId, 'attemptId');
  requireId(runId, 'runId');
  for (const [field, value] of [
    ['designRevisionHash', designRevisionHash], ['attemptHash', attemptHash],
    ['contractHash', contractHash], ['contextPackageHash', contextPackageHash],
    ['projectionProofHash', projectionProofHash], ['workspaceDigest', workspaceDigest],
    ['controllerReleaseDigest', controllerReleaseDigest],
  ]) requireHash(value, field);
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) throw attemptError('ATTEMPT_NONCE_INVALID', 'nonce is invalid');
  if (!Array.isArray(targetRootIdentities) || targetRootIdentities.length === 0
    || targetRootIdentities.some((identity) => typeof identity?.path !== 'string'
      || typeof identity?.device !== 'string' || typeof identity?.inode !== 'string')) {
    throw attemptError('TARGET_ROOT_IDENTITY_INVALID', 'target root physical identities are required');
  }
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
    controller_release_digest: controllerReleaseDigest,
    target_root_identities: structuredClone(targetRootIdentities),
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

export function createLaunchReceipt({
  intent, threadId, turnStartResponseId, turnInputSha256, turnId, authorizedTurnIds, startedAt,
}) {
  exactFields(intent, INTENT_FIELDS, 'launch_intent');
  if (typeof threadId !== 'string' || threadId.length === 0
    || typeof turnStartResponseId !== 'string' || turnStartResponseId.length === 0
    || typeof turnId !== 'string' || turnId.length === 0) {
    throw attemptError(
      'NATIVE_TURN_REQUIRED',
      'a receipt requires native thread, start-response, and persisted turn ids',
    );
  }
  requireHash(turnInputSha256, 'turnInputSha256');
  if (!Array.isArray(authorizedTurnIds)
    || authorizedTurnIds.length !== 1
    || authorizedTurnIds[0] !== turnId) {
    throw attemptError(
      'AUTHORIZED_TURNS_INVALID',
      'a receipt must authorize exactly the primary persisted native turn',
    );
  }
  return {
    receipt_version: 2,
    session_id: intent.session_id,
    attempt_id: intent.attempt_id,
    run_id: intent.run_id,
    intent_hash: launchIntentHash(intent),
    thread_id: threadId,
    turn_start_response_id: turnStartResponseId,
    turn_input_sha256: turnInputSha256,
    turn_id: turnId,
    authorized_turn_ids: structuredClone(authorizedTurnIds),
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
    controller_release_digest: intent.controller_release_digest,
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
    'projection_proof_hash', 'workspace_digest', 'controller_release_digest',
  ]) requireHash(attempt[field], field);
  if (!['Launched', 'Candidate', 'Rejected', 'Verified'].includes(attempt.status)) {
    throw attemptError('ATTEMPT_STATUS_INVALID', 'attempt status is invalid');
  }
  exactFields(attempt.launch_receipt, RECEIPT_FIELDS, 'launch_receipt');
  if (attempt.launch_receipt.receipt_version !== 2) {
    throw attemptError('LAUNCH_RECEIPT_VERSION_INVALID', 'launch receipt version is invalid');
  }
  for (const field of ['thread_id', 'turn_start_response_id', 'turn_id']) {
    if (typeof attempt.launch_receipt[field] !== 'string'
      || attempt.launch_receipt[field].length === 0) {
      throw attemptError('NATIVE_TURN_REQUIRED', `launch receipt ${field} is invalid`);
    }
  }
  requireHash(attempt.launch_receipt.turn_input_sha256, 'turn_input_sha256');
  const authorized = attempt.launch_receipt.authorized_turn_ids;
  if (!Array.isArray(authorized)
    || authorized.length !== 1
    || authorized[0] !== attempt.launch_receipt.turn_id) {
    throw attemptError('AUTHORIZED_TURNS_INVALID', 'launch receipt authorized turns are invalid');
  }
  if (!Array.isArray(attempt.bypasses)) throw attemptError('ATTEMPT_BYPASSES_INVALID', 'bypasses must be an array');
  if (attempt.candidate !== null) {
    exactFields(attempt.candidate, CANDIDATE_FIELDS, 'candidate');
    if (attempt.candidate.status !== 'ready_for_postflight' || attempt.candidate.remaining_work !== false) {
      throw attemptError('ATTEMPT_CANDIDATE_INVALID', 'candidate must be the closed controller handoff shape');
    }
  }
  for (const bypass of attempt.bypasses) {
    exactFields(bypass, BYPASS_FIELDS, 'bypass');
    if (bypass.type !== 'CONTROL_PLANE_BYPASS'
      || !Array.isArray(bypass.reason_codes)
      || bypass.reason_codes.some((reason) => typeof reason !== 'string' || reason.length === 0)) {
      throw attemptError('ATTEMPT_BYPASS_INVALID', 'bypass records must use the closed control-plane shape');
    }
  }
  return true;
}
