import assert from 'node:assert/strict';
import test from 'node:test';

import { transitionRollout } from '../src/rollout.mjs';

test('rollout follows the closed shadow to default sequence', () => {
  assert.equal(transitionRollout('shadow', 'opt-in'), 'opt-in');
  assert.equal(transitionRollout('opt-in', 'default'), 'default');
  assert.equal(transitionRollout('default', 'legacy-freeze'), 'legacy-freeze');
});

test('rollout cannot skip recovery gates', () => {
  assert.throws(
    () => transitionRollout('shadow', 'default'),
    (error) => error.code === 'ROLLOUT_TRANSITION_INVALID',
  );
});
