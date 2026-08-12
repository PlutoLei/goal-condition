import assert from 'node:assert/strict';
import test from 'node:test';

import * as controller from '../src/index.mjs';

function resolveStateRoot(options) {
  assert.equal(typeof controller.resolveControllerStateRoot, 'function');
  return controller.resolveControllerStateRoot(options);
}

function assertInvalid(options, secret = null) {
  assert.throws(
    () => resolveStateRoot(options),
    (error) => {
      assert.equal(error.code, 'STATE_ROOT_INVALID');
      if (secret !== null) assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
}

test('the controller exports one canonical state-root resolver', () => {
  assert.equal(typeof controller.resolveControllerStateRoot, 'function');
});

test('an explicit state root wins over every environment default', () => {
  assert.equal(resolveStateRoot({
    explicit: '/controller/explicit',
    environment: {
      GOAL_CONDITION_CODEX_STATE_ROOT: '/controller/environment',
      XDG_STATE_HOME: '/controller/xdg',
    },
    home: '/controller/home',
  }), '/controller/explicit');
});

test('the GoalSession-specific environment root wins over XDG and home', () => {
  assert.equal(resolveStateRoot({
    environment: {
      GOAL_CONDITION_CODEX_STATE_ROOT: '/controller/environment',
      XDG_STATE_HOME: '/controller/xdg',
    },
    home: '/controller/home',
  }), '/controller/environment');
});

test('an absolute XDG state home derives the GoalSession V2 store', () => {
  assert.equal(resolveStateRoot({
    environment: { XDG_STATE_HOME: '/controller/xdg' },
    home: '/controller/home',
  }), '/controller/xdg/goal-condition/codex-v2');
});

test('the home fallback is deterministic when no override is present', () => {
  assert.equal(resolveStateRoot({
    environment: {},
    home: '/controller/home',
  }), '/controller/home/.local/state/goal-condition/codex-v2');
});

test('a malformed higher-precedence value fails closed instead of falling through', () => {
  assertInvalid({
    environment: {
      GOAL_CONDITION_CODEX_STATE_ROOT: '',
      XDG_STATE_HOME: '/controller/xdg',
    },
    home: '/controller/home',
  });
  assertInvalid({
    environment: { XDG_STATE_HOME: 'relative-xdg' },
    home: '/controller/home',
  }, 'relative-xdg');
  assertInvalid({
    explicit: '/controller/../alias',
    environment: { GOAL_CONDITION_CODEX_STATE_ROOT: '/controller/environment' },
    home: '/controller/home',
  }, '/controller/../alias');
});

test('an invalid home cannot create an implicit relative controller store', () => {
  assertInvalid({ environment: {}, home: 'relative-home' }, 'relative-home');
});
