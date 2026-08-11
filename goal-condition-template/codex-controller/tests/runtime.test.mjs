import test from 'node:test';
import assert from 'node:assert/strict';
import { assertControllerRuntime } from '../src/values.mjs';

test('Codex controller rejects Node versions below 24.15 without changing the root runtime', () => {
  assert.throws(
    () => assertControllerRuntime('24.14.9'),
    (error) => error.code === 'CODEX_CONTROLLER_NODE_UNSUPPORTED',
  );
  assert.equal(assertControllerRuntime('24.15.0'), true);
  assert.equal(assertControllerRuntime('25.0.0'), true);
});
