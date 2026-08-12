import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson } from '../../scripts/lib/contract.mjs';
import { digestCanonical, exactFields } from './values.mjs';

export const ROLLOUT_MODES = Object.freeze(['disabled', 'canary', 'enabled']);
const LEGACY_ROLLOUT_MODES = Object.freeze(['shadow', 'opt-in', 'default', 'legacy-freeze']);
const HASH = /^[0-9a-f]{64}$/;
const NEXT = Object.freeze({
  disabled: new Set(['canary']),
  canary: new Set(['disabled', 'enabled']),
  enabled: new Set(['disabled', 'canary']),
});
const STATE_FIELDS = Object.freeze([
  'schema_version', 'mode', 'changed_at', 'release_manifest_digest', 'canary_receipt',
]);
const CANARY_FIELDS = Object.freeze([
  'receipt_version', 'session_id', 'authorization_hash', 'attempt_id', 'run_id',
  'controller_release_digest', 'design_revision_hash', 'launch_receipt_hash',
  'certification_event_hash',
]);

function rolloutError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validCanaryReceipt(receipt) {
  try {
    exactFields(receipt, CANARY_FIELDS, 'rollout_canary_receipt');
  } catch {
    return false;
  }
  return receipt.receipt_version === 2
    && ['session_id', 'attempt_id', 'run_id'].every(
      (field) => typeof receipt[field] === 'string' && receipt[field].length > 0,
    )
    && [
      'authorization_hash', 'controller_release_digest', 'design_revision_hash',
      'launch_receipt_hash', 'certification_event_hash',
    ]
      .every((field) => typeof receipt[field] === 'string' && HASH.test(receipt[field]));
}

export function certifyRolloutCanary(exported, { releaseManifestDigest } = {}) {
  const session = exported?.session;
  const events = exported?.events;
  const finalDesign = session?.design_revisions?.at(-1);
  const attempt = session?.attempts?.at(-1);
  const certification = events?.at(-1);
  const conditionIds = new Set(finalDesign?.conditions?.map((condition) => condition.id) ?? []);
  const evidenceIds = new Set((session?.evidence ?? [])
    .filter((item) => item?.attempt_id === attempt?.attempt_id
      && item.controller_owned === true && item.result === 'pass')
    .map((item) => item.condition_id));
  const priorRejected = session?.attempts?.slice(0, -1)
    .some((candidate) => candidate.status === 'Rejected');
  const dynamicRevision = session?.design_revisions?.length >= 2
    && finalDesign?.conditions?.length >= 2;
  const oneAuthorization = session?.authority_revisions?.length === 1
    && session?.confirmation_receipts?.length === 1;
  const receipt = attempt?.launch_receipt;
  const valid = session?.status === 'Complete'
    && priorRejected
    && dynamicRevision
    && oneAuthorization
    && attempt?.status === 'Verified'
    && attempt?.completion_level === 'certified'
    && HASH.test(releaseManifestDigest ?? '')
    && attempt?.controller_release_digest === releaseManifestDigest
    && attempt?.design_revision_hash === finalDesign?.design_revision_hash
    && Array.isArray(attempt?.bypasses)
    && attempt.bypasses.length === 0
    && receipt?.attempt_id === attempt?.attempt_id
    && receipt?.run_id === attempt?.run_id
    && HASH.test(receipt?.turn_input_sha256 ?? '')
    && Array.isArray(receipt?.authorized_turn_ids)
    && receipt.authorized_turn_ids.length === 1
    && receipt.authorized_turn_ids[0] === receipt.turn_id
    && conditionIds.size === finalDesign.conditions.length
    && [...conditionIds].every((id) => evidenceIds.has(id))
    && certification?.event_type === 'GOAL_SESSION_CERTIFIED'
    && typeof certification?.event_hash === 'string'
    && HASH.test(certification.event_hash);
  if (!valid) {
    throw rolloutError(
      'ROLLOUT_CANARY_INVALID',
      'enabled requires one controller-certified live canary that exercised a monotonic Design revision',
    );
  }
  return {
    receipt_version: 2,
    session_id: session.session_id,
    authorization_hash: session.authorization_hash,
    attempt_id: attempt.attempt_id,
    run_id: attempt.run_id,
    controller_release_digest: releaseManifestDigest,
    design_revision_hash: finalDesign.design_revision_hash,
    launch_receipt_hash: digestCanonical(receipt),
    certification_event_hash: certification.event_hash,
  };
}

export function transitionRollout(current, next, { canaryReceipt = null } = {}) {
  if (!ROLLOUT_MODES.includes(current) || !ROLLOUT_MODES.includes(next) || !NEXT[current].has(next)) {
    throw rolloutError('ROLLOUT_TRANSITION_INVALID', `cannot move rollout from ${current} to ${next}`);
  }
  if (next === 'enabled' && !validCanaryReceipt(canaryReceipt)) {
    throw rolloutError('ROLLOUT_CANARY_REQUIRED', 'enabled requires a certified canary receipt');
  }
  return next;
}

function disabledState() {
  return {
    schema_version: 4,
    mode: 'disabled',
    changed_at: null,
    release_manifest_digest: null,
    canary_receipt: null,
  };
}

function timestampValid(value) {
  return value === null || (typeof value === 'string' && !Number.isNaN(new Date(value).getTime()));
}

function validV2State(value) {
  try {
    exactFields(value, STATE_FIELDS, 'rollout_state');
  } catch {
    return false;
  }
  if (value.schema_version !== 4
    || !ROLLOUT_MODES.includes(value.mode)
    || !timestampValid(value.changed_at)) return false;
  if (value.mode === 'disabled') {
    return value.release_manifest_digest === null && value.canary_receipt === null;
  }
  if (!HASH.test(value.release_manifest_digest ?? '')) return false;
  if (value.mode === 'canary') return value.canary_receipt === null;
  return validCanaryReceipt(value.canary_receipt)
    && value.release_manifest_digest === value.canary_receipt.controller_release_digest;
}

function validLegacyState(value) {
  try {
    exactFields(value, STATE_FIELDS, 'legacy_rollout_state');
  } catch {
    return false;
  }
  return value.schema_version === 3
    && LEGACY_ROLLOUT_MODES.includes(value.mode)
    && timestampValid(value.changed_at)
    && (['default', 'legacy-freeze'].includes(value.mode)
      ? validCanaryReceipt(value.canary_receipt)
        && value.release_manifest_digest === value.canary_receipt.controller_release_digest
      : value.canary_receipt === null && value.release_manifest_digest === null);
}

function parseRolloutState(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw rolloutError('ROLLOUT_STATE_INVALID', 'rollout state is invalid');
  }
}

function writeState(path, state) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, canonicalJson(state), { mode: 0o600 });
  renameSync(temporary, path);
}

export function readRolloutState(path) {
  const value = parseRolloutState(path);
  if (value === null) return disabledState();
  if (!validV2State(value)) throw rolloutError('ROLLOUT_STATE_INVALID', 'rollout state is invalid');
  return value;
}

export function ensureRolloutState(path, { releaseManifestDigest } = {}) {
  const value = parseRolloutState(path);
  if (value === null) return disabledState();
  if (validV2State(value)) return value;
  if (!validLegacyState(value)) throw rolloutError('ROLLOUT_STATE_INVALID', 'rollout state is invalid');
  let next;
  if (value.mode === 'shadow') {
    next = { ...disabledState(), changed_at: value.changed_at };
  } else if (value.mode === 'opt-in') {
    if (!HASH.test(releaseManifestDigest ?? '')) {
      throw rolloutError('ROLLOUT_RELEASE_REQUIRED', 'legacy canary migration requires the installed release digest');
    }
    next = {
      schema_version: 4,
      mode: 'canary',
      changed_at: value.changed_at,
      release_manifest_digest: releaseManifestDigest,
      canary_receipt: null,
    };
  } else {
    next = {
      schema_version: 4,
      mode: 'enabled',
      changed_at: value.changed_at,
      release_manifest_digest: value.release_manifest_digest,
      canary_receipt: value.canary_receipt,
    };
  }
  writeState(path, next);
  return next;
}

export function readRolloutMode(path, options) {
  return ensureRolloutState(path, options).mode;
}

export function writeRolloutMode({
  path, current, next, changedAt, canaryReceipt = null, releaseManifestDigest,
}) {
  const mode = transitionRollout(current, next, { canaryReceipt });
  const timestamp = new Date(changedAt);
  if (Number.isNaN(timestamp.getTime())) throw rolloutError('ROLLOUT_TIME_INVALID', 'changedAt is invalid');
  if (mode !== 'disabled' && !HASH.test(releaseManifestDigest ?? '')) {
    throw rolloutError('ROLLOUT_RELEASE_REQUIRED', 'live V2 rollout requires the installed release digest');
  }
  const nextReceipt = mode === 'enabled' ? canaryReceipt : null;
  const state = {
    schema_version: 4,
    mode,
    changed_at: timestamp.toISOString(),
    release_manifest_digest: mode === 'disabled' ? null : releaseManifestDigest,
    canary_receipt: nextReceipt,
  };
  if (!validV2State(state)) throw rolloutError('ROLLOUT_STATE_INVALID', 'next rollout state is invalid');
  writeState(path, state);
  return mode;
}

export function assertLiveRollout(stateRoot, { releaseManifestDigest } = {}) {
  const state = ensureRolloutState(join(stateRoot, 'rollout.json'), { releaseManifestDigest });
  const { mode } = state;
  if (mode === 'disabled') {
    throw rolloutError(
      'ROLLOUT_LIVE_BLOCKED',
      'live GoalSession commands are disabled by the V2 release gate',
    );
  }
  if (!HASH.test(releaseManifestDigest ?? '')
    || state.release_manifest_digest !== releaseManifestDigest) {
    throw rolloutError(
      'ROLLOUT_RELEASE_MISMATCH',
      'the live rollout was certified by a different controller release',
    );
  }
  return mode;
}
