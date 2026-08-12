import { randomBytes } from 'node:crypto';

const CONTROLLER_ID_KINDS = new Set(['session', 'run']);

function identityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createControllerId(kind) {
  if (!CONTROLLER_ID_KINDS.has(kind)) {
    throw identityError('CONTROLLER_ID_KIND_INVALID', 'controller identifier kind is not supported');
  }
  return `${kind}-${randomBytes(16).toString('hex')}`;
}
