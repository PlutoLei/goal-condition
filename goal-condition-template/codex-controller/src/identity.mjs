import { randomBytes } from 'node:crypto';

const CONTROLLER_ID_KINDS = new Set(['session', 'run']);
const CREATION_REQUEST_ID = /^[0-9a-f]{32}$/;

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

export function assertCreationRequestId(value) {
  if (typeof value !== 'string' || !CREATION_REQUEST_ID.test(value)) {
    throw identityError(
      'CREATION_REQUEST_ID_INVALID',
      'creation request ids must be exactly 128 bits encoded as lowercase hex',
    );
  }
  return value;
}
