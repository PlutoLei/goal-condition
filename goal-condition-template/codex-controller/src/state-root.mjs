import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function stateRootError() {
  const error = new Error('controller state root must be a normalized absolute path');
  error.code = 'STATE_ROOT_INVALID';
  return error;
}

function requireAbsolute(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || !isAbsolute(value)
    || resolve(value) !== value) {
    throw stateRootError();
  }
  return value;
}

export function resolveControllerStateRoot({
  explicit,
  environment = process.env,
  home = homedir(),
} = {}) {
  if (explicit !== undefined) return requireAbsolute(explicit);
  if (hasOwn(environment, 'GOAL_CONDITION_CODEX_STATE_ROOT')) {
    return requireAbsolute(environment.GOAL_CONDITION_CODEX_STATE_ROOT);
  }
  if (hasOwn(environment, 'XDG_STATE_HOME')) {
    return join(requireAbsolute(environment.XDG_STATE_HOME), 'goal-condition', 'codex-v2');
  }
  return join(requireAbsolute(home), '.local', 'state', 'goal-condition', 'codex-v2');
}

