import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEvidence } from '../skills/goal-condition/scripts/check-evidence.mjs';

const report = () => ({
  criteria: [{ id: 'request-contract', required: true, required_level: 'mock', status: 'passed' }],
  evidence: [{ id: 'test-output', criterion_id: 'request-contract', level: 'mock', passed: true, current: true, source: 'artifacts/unit-test.txt' }],
  remaining_work: [],
});

test('a current passing request-contract report establishes only its declared scope', () => {
  assert.equal(checkEvidence(report()).requirements_met, true);
});
for (const status of ['failed', 'not-run', 'not-applicable']) {
  test(`a required criterion cannot finish as ${status}`, () => {
    const r = report(); r.criteria[0].status = status;
    assert.equal(checkEvidence(r).requirements_met, false);
  });
}
for (const field of ['passed', 'current']) {
  test(`evidence with ${field}=false prevents completion`, () => {
    const r = report(); r.evidence[0][field] = false;
    assert.equal(checkEvidence(r).requirements_met, false);
  });
}
for (const required of ['local', 'external', 'independent']) {
  test(`mock evidence does not prove ${required} validation`, () => {
    const r = report(); r.criteria[0].required_level = required;
    assert.equal(checkEvidence(r).requirements_met, false);
  });
}
test('an independent review does not stand in for an external run', () => {
  const r = report(); r.criteria[0].required_level = 'external'; r.evidence[0].level = 'independent';
  assert.equal(checkEvidence(r).requirements_met, false);
});
test('missing, ambiguous, unrelated or malformed evidence is rejected', () => {
  const mutations = [
    (r) => { r.evidence = []; },
    (r) => { r.evidence.push({ ...r.evidence[0] }); },
    (r) => { r.criteria.push({ ...r.criteria[0] }); },
    (r) => { r.evidence[0].criterion_id = 'another-goal'; },
    (r) => { r.evidence[0].source = ''; },
    (r) => { r.evidence[0].passed = 'true'; },
    (r) => { r.criteria[0].required = false; },
    (r) => { r.remaining_work = ['real API evaluation']; },
  ];
  for (const mutate of mutations) {
    const r = report(); mutate(r); assert.equal(checkEvidence(r).requirements_met, false);
  }
  assert.equal(checkEvidence(null).requirements_met, false);
});
test('optional exclusions remain visible and need a reason', () => {
  const r = report();
  r.criteria.push({ id: 'publish', required: false, required_level: 'external', status: 'not-applicable', reason: 'Not requested' });
  assert.equal(checkEvidence(r).requirements_met, true);
  assert.deepEqual(checkEvidence(r).exclusions, [{ criterion: 'publish', status: 'not-applicable' }]);
  delete r.criteria[1].reason;
  assert.equal(checkEvidence(r).requirements_met, false);
});
test('contradictory or stale items cannot be hidden behind a passing item', () => {
  const r = report(); r.evidence.push({ ...r.evidence[0], id: 'failed-test', passed: false });
  assert.equal(checkEvidence(r).requirements_met, false);
});
test('source strings are inert data, not commands', () => {
  const r = report(); r.evidence[0].source = '$(exit 17); `exit 19`';
  assert.equal(checkEvidence(r).requirements_met, true);
});
