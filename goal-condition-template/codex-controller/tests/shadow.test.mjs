import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { classifyShadowReplay } from '../src/shadow.mjs';

const validContract = JSON.parse(
  await readFile(new URL('../../tests/fixtures/valid-contract.json', import.meta.url), 'utf8'),
);

function replay(overrides = {}) {
  return {
    legacy_contract: structuredClone(validContract),
    current_contract: structuredClone(validContract),
    candidate: { terminal_reason: 'completed' },
    postflight: { ok: false },
    observations: {},
    ...overrides,
  };
}

test('same Goal and Authority with typed design delta becomes an automatic proposal', () => {
  const input = replay();
  input.observations.typed_operation = { type: 'ADD_CONDITION' };
  const result = classifyShadowReplay(input);
  assert.equal(result.operation.type, 'ADD_CONDITION');
  assert.equal(result.decision, 'auto_apply');
});

test('root expansion becomes EXPAND_AUTHORITY', () => {
  const input = replay();
  input.current_contract.target_roots.push('/work/new-root');
  const result = classifyShadowReplay(input);
  assert.equal(result.operation.type, 'EXPAND_AUTHORITY');
  assert.equal(result.decision, 'reauthorize');
});

test('weaker Condition becomes WEAKEN_CONDITION', () => {
  const input = replay();
  input.observations.condition_change = 'weaker';
  const result = classifyShadowReplay(input);
  assert.equal(result.operation.type, 'WEAKEN_CONDITION');
  assert.equal(result.decision, 'reauthorize');
});

test('objective semantic change requires a successor', () => {
  const input = replay();
  input.current_contract.objective = 'Publish a different deliverable.';
  const result = classifyShadowReplay(input);
  assert.equal(result.operation.type, 'CHANGE_GOAL');
  assert.equal(result.decision, 'successor_required');
});

test('unknown diff fails closed as UNCLASSIFIED', () => {
  const input = replay();
  input.current_contract.allowed_mutations.external.push('unknown side effect');
  const result = classifyShadowReplay(input);
  assert.equal(result.operation.type, 'UNCLASSIFIED');
  assert.equal(result.decision, 'reject');
});
