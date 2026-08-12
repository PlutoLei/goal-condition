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

test('caller-known creation request ids are exactly 128-bit lowercase hex', () => {
  assert.equal(
    controller.assertCreationRequestId('00112233445566778899aabbccddeeff'),
    '00112233445566778899aabbccddeeff',
  );
  for (const invalid of ['0'.repeat(31), '0'.repeat(33), 'A'.repeat(32), 'request-key']) {
    assert.throws(
      () => controller.assertCreationRequestId(invalid),
      (error) => error.code === 'CREATION_REQUEST_ID_INVALID',
    );
  }
});
