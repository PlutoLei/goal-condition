import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGoalSession,
  hashDesignRevision,
  transitionAttempt,
  transitionSession,
} from '../src/domain.mjs';
import { evaluateRevision } from '../src/policy.mjs';
import { validDraft } from './helpers.mjs';

function operation(type, payload) {
  return {
    version: 1,
    type,
    reason: `test ${type}`,
    evidence_refs: [],
    payload,
  };
}

function baseSession({ narrowed = false } = {}) {
  const draft = validDraft();
  draft.initial_design.conditions[0].predicate = {
    metric: 'coverage_percent',
    comparator: 'gte',
    value: 80,
  };
  draft.initial_design.context_dependencies = [
    { id: 'context-main', path: '/work/project/context.md', sha256: 'b'.repeat(64) },
  ];
  if (narrowed) draft.initial_design.active_boundary.actions = ['read'];
  return createGoalSession(draft);
}

function newCondition() {
  const condition = structuredClone(baseSession().design_revisions[0].conditions[0]);
  condition.id = 'condition-regression';
  condition.verifier.id = 'verify-regression';
  condition.projection.criterion_id = 'success-regression';
  condition.introduced_by = 'revision-test';
  condition.predicate.value = 90;
  return condition;
}

function fixtureFor(type) {
  const session = baseSession({ narrowed: type === 'EXPAND_WITHIN_AUTHORITY' });
  const current = session.design_revisions.at(-1);
  const boundary = structuredClone(current.active_boundary);
  switch (type) {
    case 'ADD_CONDITION':
      return { session, operation: operation(type, { condition: newCondition() }), controllerFacts: {} };
    case 'ADD_AND_VERIFIER':
      return {
        session,
        operation: operation(type, { condition: newCondition() }),
        controllerFacts: { verifier_controlled: true, dependencies_declared: true },
      };
    case 'TIGHTEN_TYPED_THRESHOLD':
      return {
        session,
        operation: operation(type, {
          condition_id: 'condition-tests',
          comparator: 'gte',
          from: 80,
          to: 90,
        }),
        controllerFacts: { predicate_readback: true },
      };
    case 'NARROW_ACTIVE_BOUNDARY':
      boundary.actions = ['read'];
      return { session, operation: operation(type, { active_boundary: boundary }), controllerFacts: {} };
    case 'EXPAND_WITHIN_AUTHORITY':
      boundary.actions = ['read', 'write'];
      return {
        session,
        operation: operation(type, { active_boundary: boundary }),
        controllerFacts: { boundary_fact_checked: true },
      };
    case 'REFRESH_CONTEXT':
      return {
        session,
        operation: operation(type, {
          dependency_id: 'context-main',
          prior_hash: 'b'.repeat(64),
          next_hash: 'c'.repeat(64),
        }),
        controllerFacts: { context_hash_verified: true },
      };
    case 'REPLACE_EQUIVALENT_VERIFIER': {
      const verifier = structuredClone(current.conditions[0].verifier);
      verifier.argv = ['npm', 'run', 'test:ci'];
      return {
        session,
        operation: operation(type, {
          condition_id: 'condition-tests',
          verifier,
          proof_ref: 'proof-parity-1',
        }),
        controllerFacts: {
          equivalence_proof: { proof_ref: 'proof-parity-1', kind: 'parity', passed: true },
        },
      };
    }
    case 'CONTROLLER_CORRECTION':
      return {
        session,
        operation: operation(type, {
          field: 'projection_version',
          prior_hash: hashDesignRevision(current),
          next_value: 'v1.1',
        }),
        controllerFacts: { correction_verified: true },
      };
    case 'EXPAND_AUTHORITY': {
      const authority = structuredClone(session.authority_revisions.at(-1).authority);
      authority.target_roots.push('/work/second-project');
      return { session, operation: operation(type, { authority }), controllerFacts: {} };
    }
    case 'WEAKEN_CONDITION':
      return {
        session,
        operation: operation(type, {
          condition_id: 'condition-tests',
          replacement: { ...current.conditions[0], rule: 'Most tests pass.' },
        }),
        controllerFacts: {},
      };
    case 'CHANGE_GOAL':
      return {
        session,
        operation: operation(type, {
          goal: { statement: 'Deploy the change.', deliverables: session.goal.deliverables },
          non_goals: [],
        }),
        controllerFacts: {},
      };
    case 'UNCLASSIFIED':
      return {
        session,
        operation: operation(type, { description: 'free-text change' }),
        controllerFacts: {},
      };
    default:
      throw new Error(`unknown fixture ${type}`);
  }
}

const cases = [
  ['ADD_CONDITION', 'auto_apply'],
  ['ADD_AND_VERIFIER', 'auto_apply'],
  ['TIGHTEN_TYPED_THRESHOLD', 'auto_apply'],
  ['NARROW_ACTIVE_BOUNDARY', 'auto_apply'],
  ['EXPAND_WITHIN_AUTHORITY', 'auto_apply'],
  ['REFRESH_CONTEXT', 'auto_apply'],
  ['REPLACE_EQUIVALENT_VERIFIER', 'auto_apply'],
  ['CONTROLLER_CORRECTION', 'auto_apply'],
  ['EXPAND_AUTHORITY', 'reauthorize'],
  ['WEAKEN_CONDITION', 'reauthorize'],
  ['CHANGE_GOAL', 'successor_required'],
  ['UNCLASSIFIED', 'reject'],
];
for (const [type, expected] of cases) {
  test(type, () => assert.equal(evaluateRevision(fixtureFor(type)).decision, expected));
}

test('ADD_CONDITION with an unknown deliverable requires a successor', () => {
  const fixture = fixtureFor('ADD_CONDITION');
  fixture.operation.payload.condition.deliverable_ref = 'delivery-new';
  assert.equal(evaluateRevision(fixture).decision, 'successor_required');
});

test('EXPAND_WITHIN_AUTHORITY outside the maximum envelope requires reauthorization', () => {
  const fixture = fixtureFor('EXPAND_WITHIN_AUTHORITY');
  fixture.operation.payload.active_boundary.target_roots.push('/srv/not-authorized');
  assert.equal(evaluateRevision(fixture).decision, 'reauthorize');
});

test('TIGHTEN_TYPED_THRESHOLD rejects a decreasing gte threshold', () => {
  const fixture = fixtureFor('TIGHTEN_TYPED_THRESHOLD');
  fixture.operation.payload.to = 70;
  assert.equal(evaluateRevision(fixture).decision, 'reject');
});

test('REPLACE_EQUIVALENT_VERIFIER rejects missing controller proof', () => {
  const fixture = fixtureFor('REPLACE_EQUIVALENT_VERIFIER');
  fixture.controllerFacts = {};
  assert.equal(evaluateRevision(fixture).decision, 'reject');
});

test('executor monotonic claims are not controller facts', () => {
  const fixture = fixtureFor('TIGHTEN_TYPED_THRESHOLD');
  fixture.controllerFacts = {};
  fixture.operation.monotonic = true;
  assert.equal(evaluateRevision(fixture).decision, 'reject');
});

function confirmationReceipt(session) {
  return {
    receipt_version: 1,
    session_id: session.session_id,
    goal_hash: session.goal_hash,
    authority_revision_hash: session.authority_revisions.at(-1).authority_revision_hash,
    authorization_hash: session.authorization_hash,
    presented_design_hash: session.design_revisions.at(-1).design_revision_hash,
    short_fingerprint: session.authorization_hash.slice(0, 12),
    confirmed_at: '2026-08-11T00:00:00.000Z',
    thread_id: 'thread-1',
    turn_or_message_ref: 'turn-1',
    confirmation_source: 'user_message',
  };
}

test('session transitions reject no-receipt Ready, false Complete, and reconciliation bypass', () => {
  const draft = baseSession();
  const awaiting = transitionSession(draft, { type: 'DRAFT_COMPILED' });
  assert.equal(awaiting.status, 'AwaitingConfirmation');
  assert.throws(
    () => transitionSession(awaiting, { type: 'AUTHORIZATION_CONFIRMED' }),
    (error) => error.code === 'CONFIRMATION_RECEIPT_REQUIRED',
  );
  const ready = transitionSession(awaiting, {
    type: 'AUTHORIZATION_CONFIRMED',
    receipt: confirmationReceipt(awaiting),
  });
  const running = transitionSession(ready, { type: 'ATTEMPT_LAUNCHED', turn_started: true });
  const evaluating = transitionSession(running, { type: 'ATTEMPT_CANDIDATE' });
  assert.throws(
    () => transitionSession(evaluating, { type: 'CERTIFIED' }),
    (error) => error.code === 'CERTIFIED_EVIDENCE_REQUIRED',
  );
  assert.equal(transitionSession(evaluating, {
    type: 'CERTIFIED',
    certification: { level: 'certified', controller_owned: true },
  }).status, 'Complete');

  const reconciliation = transitionSession(ready, { type: 'RECONCILIATION_REQUIRED' });
  assert.throws(
    () => transitionSession(reconciliation, { type: 'ATTEMPT_LAUNCHED', turn_started: true }),
    (error) => error.code === 'ILLEGAL_SESSION_TRANSITION',
  );
});

test('attempt transitions are exact and pre-turn failure creates no attempt', () => {
  assert.equal(transitionAttempt(null, { type: 'PREFLIGHT_FAILED' }), null);
  const prepared = { attempt_id: 'attempt-1', status: 'Prepared' };
  const launched = transitionAttempt(prepared, { type: 'TURN_STARTED' });
  const candidate = transitionAttempt(launched, { type: 'RUNTIME_COMPLETED' });
  assert.equal(candidate.status, 'Candidate');
  assert.equal(transitionAttempt(candidate, { type: 'POSTFLIGHT_VERIFIED' }).status, 'Verified');
  assert.throws(
    () => transitionAttempt(prepared, { type: 'POSTFLIGHT_VERIFIED' }),
    (error) => error.code === 'ILLEGAL_ATTEMPT_TRANSITION',
  );
});

test('500 deterministic event sequences preserve Goal, baseline, and authorization', () => {
  let seed = 0x5eed1234;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const eventTypes = [
    'DRAFT_COMPILED',
    'AUTHORIZATION_CONFIRMED',
    'ATTEMPT_LAUNCHED',
    'ATTEMPT_CANDIDATE',
    'REVISION_REQUIRED',
    'REVISION_APPLIED',
    'RECONCILIATION_REQUIRED',
    'RECONCILED',
    'BLOCK',
    'UNBLOCKED',
    'CERTIFIED',
  ];
  for (let sequence = 0; sequence < 500; sequence += 1) {
    let session = baseSession();
    const immutable = {
      goal_hash: session.goal_hash,
      root_baseline_hash: session.root_baseline_hash,
      authorization_hash: session.authorization_hash,
    };
    for (let step = 0; step < 20; step += 1) {
      const type = eventTypes[Math.floor(random() * eventTypes.length)];
      const event = {
        type,
        receipt: confirmationReceipt(session),
        turn_started: true,
        certification: { level: 'certified', controller_owned: true },
        reconciliation: { controller_owned: true },
        resolution: { controller_owned: true },
      };
      try {
        session = transitionSession(session, event);
      } catch (error) {
        assert.ok([
          'ILLEGAL_SESSION_TRANSITION',
          'CONFIRMATION_RECEIPT_REQUIRED',
          'CERTIFIED_EVIDENCE_REQUIRED',
        ].includes(error.code));
      }
      assert.equal(session.goal_hash, immutable.goal_hash);
      assert.equal(session.root_baseline_hash, immutable.root_baseline_hash);
      assert.equal(session.authorization_hash, immutable.authorization_hash);
    }
  }
});
