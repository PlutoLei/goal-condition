import { createHash } from 'node:crypto';

import { canonicalJson } from '../../scripts/lib/contract.mjs';

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
