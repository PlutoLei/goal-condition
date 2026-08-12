import assert from 'node:assert/strict';
import test from 'node:test';

import * as controller from '../src/index.mjs';

test('controller issues collision-resistant machine-global session and run identifiers', () => {
  assert.equal(typeof controller.createControllerId, 'function');
  const session = controller.createControllerId('session');
  const run = controller.createControllerId('run');
  assert.match(session, /^session-[0-9a-f]{32}$/);
  assert.match(run, /^run-[0-9a-f]{32}$/);
  assert.notEqual(controller.createControllerId('session'), session);
});

test('controller identifier kinds are closed-world', () => {
  assert.throws(
    () => controller.createControllerId('attempt'),
    (error) => error.code === 'CONTROLLER_ID_KIND_INVALID',
  );
});
