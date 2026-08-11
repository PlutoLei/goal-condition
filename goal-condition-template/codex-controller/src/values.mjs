import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
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

function prospectiveRealpath(path) {
  const suffix = [];
  let cursor = path;
  while (!existsSync(cursor)) {
    const parent = resolve(cursor, '..');
    if (parent === cursor) throw valueError('PATH_IDENTITY_UNAVAILABLE', 'path has no existing ancestor');
    suffix.unshift(cursor.slice(parent.length + (parent.endsWith('/') ? 0 : 1)));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

export function captureRootIdentities(roots) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw valueError('TARGET_ROOT_INVALID', 'at least one target root is required', 'targetRoots');
  }
  return roots.map((root, index) => {
    if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root) {
      throw valueError('TARGET_ROOT_INVALID', 'target roots must be normalized absolute paths', `targetRoots[${index}]`);
    }
    let physical;
    let info;
    try {
      physical = realpathSync(root);
      info = statSync(root);
    } catch {
      throw valueError('TARGET_ROOT_INVALID', 'target roots must exist and be readable', `targetRoots[${index}]`);
    }
    if (physical !== root) {
      throw valueError(
        'TARGET_ROOT_SYMLINKED',
        'target roots and every ancestor must use their canonical physical path',
        `targetRoots[${index}]`,
      );
    }
    if (!info.isDirectory()) {
      throw valueError('TARGET_ROOT_INVALID', 'target roots must be directories', `targetRoots[${index}]`);
    }
    return { path: root, device: String(info.dev), inode: String(info.ino) };
  });
}

export function assertRootIdentities(expected) {
  if (!Array.isArray(expected) || expected.length === 0) {
    throw valueError('TARGET_ROOT_IDENTITY_INVALID', 'target root identities are required');
  }
  const current = captureRootIdentities(expected.map((identity) => identity?.path));
  if (canonicalJson(current) !== canonicalJson(expected)) {
    throw valueError(
      'TARGET_ROOT_IDENTITY_CHANGED',
      'a target root physical identity changed after the LaunchIntent was signed',
    );
  }
  return true;
}

export function assertStableStateRoot({ stateRoot, targetRoots = [] }) {
  if (typeof stateRoot !== 'string' || !isAbsolute(stateRoot) || resolve(stateRoot) !== stateRoot) {
    throw valueError('STATE_ROOT_INVALID', 'controller stateRoot must be a normalized absolute path', 'stateRoot');
  }
  if (isTemporaryPath(stateRoot)) {
    throw valueError('STATE_ROOT_TEMPORARY', 'controller stateRoot must not use a temporary directory', 'stateRoot');
  }
  if (prospectiveRealpath(stateRoot) !== stateRoot) {
    throw valueError(
      'STATE_ROOT_SYMLINKED',
      'controller stateRoot and every ancestor must use their canonical physical path',
      'stateRoot',
    );
  }
  for (const [index, targetRoot] of targetRoots.entries()) {
    if (typeof targetRoot !== 'string' || !isAbsolute(targetRoot) || resolve(targetRoot) !== targetRoot) {
      throw valueError('TARGET_ROOT_INVALID', 'target roots must be normalized absolute paths', `targetRoots[${index}]`);
    }
    if (prospectiveRealpath(targetRoot) !== targetRoot) {
      throw valueError(
        'TARGET_ROOT_SYMLINKED',
        'target roots and every existing ancestor must use their canonical physical path',
        `targetRoots[${index}]`,
      );
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
