import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';

import { canonicalJson, isTemporaryPath } from '../../scripts/lib/contract.mjs';

function valueError(code, message, path) {
  const error = new Error(message);
  error.code = code;
  if (path !== undefined) error.path = path;
  return error;
}

export function assertControllerRuntime(version = process.versions.node) {
  const [major, minor, patch] = version.split('.').map(Number);
  const supported = major > 24 || (major === 24 && (minor > 15 || (minor === 15 && patch >= 0)));
  if (supported) return true;

  const error = new Error('Codex GoalSession v2 requires Node.js 24.15.0 or newer');
  error.code = 'CODEX_CONTROLLER_NODE_UNSUPPORTED';
  throw error;
}

export function digestCanonical(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function exactFields(value, fields, name = 'value') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw valueError('OBJECT_REQUIRED', `${name} must be an object`, name);
  }
  const unknown = Object.keys(value).filter((field) => !fields.includes(field)).sort();
  if (unknown.length > 0) {
    throw valueError('UNKNOWN_FIELD', `${name} contains unknown field ${unknown[0]}`, name);
  }
  return true;
}

function pathsOverlap(left, right) {
  const delta = relative(left, right);
  return delta === '' || (!delta.startsWith('..') && !isAbsolute(delta));
}

export function assertStableStateRoot({ stateRoot, targetRoots = [] }) {
  if (typeof stateRoot !== 'string' || !isAbsolute(stateRoot) || resolve(stateRoot) !== stateRoot) {
    throw valueError('STATE_ROOT_INVALID', 'controller stateRoot must be a normalized absolute path', 'stateRoot');
  }
  if (isTemporaryPath(stateRoot)) {
    throw valueError('STATE_ROOT_TEMPORARY', 'controller stateRoot must not use a temporary directory', 'stateRoot');
  }
  for (const targetRoot of targetRoots) {
    if (typeof targetRoot !== 'string' || !isAbsolute(targetRoot) || resolve(targetRoot) !== targetRoot) {
      throw valueError('TARGET_ROOT_INVALID', 'target roots must be normalized absolute paths', 'targetRoots');
    }
    if (pathsOverlap(targetRoot, stateRoot) || pathsOverlap(stateRoot, targetRoot)) {
      throw valueError(
        'STATE_ROOT_OVERLAPS_TARGET',
        'controller stateRoot must be outside every executor target root',
        'stateRoot',
      );
    }
  }
  return true;
}
