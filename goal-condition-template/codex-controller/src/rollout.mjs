import { readFileSync, renameSync, writeFileSync } from 'node:fs';

import { canonicalJson } from '../../scripts/lib/contract.mjs';

export const ROLLOUT_MODES = Object.freeze(['shadow', 'opt-in', 'default', 'legacy-freeze']);
const NEXT = Object.freeze({
  shadow: new Set(['opt-in']),
  'opt-in': new Set(['shadow', 'default']),
  default: new Set(['opt-in', 'legacy-freeze']),
  'legacy-freeze': new Set(['default']),
});

function rolloutError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function transitionRollout(current, next) {
  if (!ROLLOUT_MODES.includes(current) || !ROLLOUT_MODES.includes(next) || !NEXT[current].has(next)) {
    throw rolloutError('ROLLOUT_TRANSITION_INVALID', `cannot move rollout from ${current} to ${next}`);
  }
  return next;
}

export function readRolloutMode(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value?.schema_version !== 1 || !ROLLOUT_MODES.includes(value.mode)) throw new Error('invalid');
    return value.mode;
  } catch (error) {
    if (error.code === 'ENOENT') return 'shadow';
    throw rolloutError('ROLLOUT_STATE_INVALID', 'rollout state is invalid');
  }
}

export function writeRolloutMode({ path, current, next, changedAt }) {
  const mode = transitionRollout(current, next);
  const timestamp = new Date(changedAt);
  if (Number.isNaN(timestamp.getTime())) throw rolloutError('ROLLOUT_TIME_INVALID', 'changedAt is invalid');
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, canonicalJson({ schema_version: 1, mode, changed_at: timestamp.toISOString() }), { mode: 0o600 });
  renameSync(temporary, path);
  return mode;
}
