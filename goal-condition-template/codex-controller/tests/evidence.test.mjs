import assert from 'node:assert/strict';
import test from 'node:test';

import { compileDraft, recordConfirmation } from '../src/compiler.mjs';
import { transitionSession } from '../src/domain.mjs';
import {
  completionLevel,
  evaluateConditionEvidence,
  invalidateForRevision,
  recordEvidence,
} from '../src/evidence.mjs';
import { digestCanonical } from '../src/values.mjs';
import { validDraft } from './helpers.mjs';

function sessionWithAllConditions() {
  const draft = validDraft();
  draft.initial_design.context_dependencies = [
    { id: 'context-main', path: '/work/project/context.md', sha256: 'b'.repeat(64) },
  ];
  const compiled = compileDraft(draft);
  const receipt = recordConfirmation({
    session: compiled.session,
    observed: {
      authorization_hash: compiled.session.authorization_hash,
      thread_id: 'thread-evidence',
      message_ref: 'message-confirmed',
      source: 'codex-task',
      confirmed_at: '2026-08-11T00:00:00.000Z',
    },
  });
  return transitionSession(compiled.session, { type: 'AUTHORIZATION_CONFIRMED', receipt });
}

function conditionInputs(session, extras = []) {
  return [
    { kind: 'root_baseline', id: session.session_id, sha256: session.root_baseline_hash },
    ...session.design_revisions.at(-1).context_dependencies.map((dependency) => ({
      kind: 'context',
      id: dependency.id,
      sha256: dependency.sha256,
    })),
    ...extras,
  ];
}

function evidenceFor(session, overrides = {}) {
  const condition = session.design_revisions.at(-1).conditions[0];
  return recordEvidence({
    evidenceId: overrides.evidenceId ?? 'evidence-tests',
    condition,
    attemptId: overrides.attemptId ?? 'attempt-1',
    inputHashes: overrides.inputHashes ?? conditionInputs(session),
    result: overrides.result ?? 'pass',
    outputBytes: overrides.outputBytes ?? 'tests passed',
    capturedAt: overrides.capturedAt ?? '2026-08-11T00:00:00.000Z',
    expiresAt: overrides.expiresAt ?? null,
    controllerOwned: overrides.controllerOwned ?? true,
  });
}

test('recordEvidence binds verifier version and inputs without mutating Condition satisfaction', () => {
  const session = sessionWithAllConditions();
  const condition = session.design_revisions.at(-1).conditions[0];
  const evidence = evidenceFor(session);
  assert.equal('satisfied' in condition, false);
  assert.equal(evidence.verifier_version_hash, digestCanonical(condition.verifier));
  assert.deepEqual(evidence.input_hashes, conditionInputs(session));
  assert.equal(evidence.controller_owned, true);
});

test('new Condition invalidates only itself', () => {
  const session = sessionWithAllConditions();
  const existing = evidenceFor(session);
  const result = invalidateForRevision({
    evidence: [existing],
    change: { type: 'ADD_CONDITION', condition_id: 'condition-new' },
    rootBaselineHash: session.root_baseline_hash,
  });
  assert.deepEqual(result.invalidated_condition_ids, ['condition-new']);
  assert.deepEqual(result.invalidated_evidence_ids, []);
  assert.deepEqual(result.preserved_evidence_ids, ['evidence-tests']);
});

test('Context hash change invalidates only dependent Evidence', () => {
  const session = sessionWithAllConditions();
  const dependent = evidenceFor(session);
  const independent = evidenceFor(session, {
    evidenceId: 'evidence-independent',
    inputHashes: [{ kind: 'root_baseline', id: session.session_id, sha256: session.root_baseline_hash }],
  });
  const result = invalidateForRevision({
    evidence: [dependent, independent],
    change: { type: 'REFRESH_CONTEXT', dependency_id: 'context-main' },
    rootBaselineHash: session.root_baseline_hash,
  });
  assert.deepEqual(result.invalidated_evidence_ids, ['evidence-tests']);
  assert.deepEqual(result.preserved_evidence_ids, ['evidence-independent']);
});

test('verifier change invalidates its Evidence even when the ID is unchanged', () => {
  const session = sessionWithAllConditions();
  const condition = structuredClone(session.design_revisions.at(-1).conditions[0]);
  const evidence = evidenceFor(session);
  condition.verifier.argv = ['npm', 'run', 'test:ci'];
  const evaluated = evaluateConditionEvidence({
    condition,
    evidence: [evidence],
    currentInputs: conditionInputs(session),
    now: '2026-08-11T00:01:00.000Z',
  });
  assert.equal(evaluated.satisfied, false);
  assert.match(evaluated.reason_codes.join(','), /VERIFIER_VERSION_MISMATCH/);
});

test('Boundary expansion invalidates snapshot, preflight, and impacted Conditions', () => {
  const session = sessionWithAllConditions();
  const evidence = evidenceFor(session);
  const result = invalidateForRevision({
    evidence: [evidence],
    change: {
      type: 'EXPAND_WITHIN_AUTHORITY',
      impacted_condition_ids: ['condition-tests'],
    },
    rootBaselineHash: session.root_baseline_hash,
  });
  assert.deepEqual(result.invalidated_evidence_ids, ['evidence-tests']);
  assert.deepEqual(result.invalidated_resources, ['attempt_snapshot', 'preflight']);
  assert.equal(result.requires_preflight, true);
});

test('projection-only format change preserves business Evidence', () => {
  const session = sessionWithAllConditions();
  const evidence = evidenceFor(session);
  const result = invalidateForRevision({
    evidence: [evidence],
    change: { type: 'CONTROLLER_CORRECTION', scope: 'projection_only' },
    rootBaselineHash: session.root_baseline_hash,
  });
  assert.deepEqual(result.invalidated_evidence_ids, []);
  assert.deepEqual(result.preserved_evidence_ids, ['evidence-tests']);
  assert.deepEqual(result.invalidated_resources, ['attempt', 'projection_proof']);
});

for (const [label, kind, type] of [
  ['artifact hash change', 'artifact', 'ARTIFACT_CHANGED'],
  ['runtime version change', 'runtime', 'RUNTIME_VERSION_CHANGED'],
]) {
  test(`${label} invalidates declared dependents`, () => {
    const session = sessionWithAllConditions();
    const dependent = evidenceFor(session, {
      inputHashes: conditionInputs(session, [{ kind, id: `${kind}-main`, sha256: 'c'.repeat(64) }]),
    });
    const result = invalidateForRevision({
      evidence: [dependent],
      change: { type, dependency_id: `${kind}-main` },
      rootBaselineHash: session.root_baseline_hash,
    });
    assert.deepEqual(result.invalidated_evidence_ids, ['evidence-tests']);
  });
}

test('Authority expansion requires preflight and preserves the root baseline', () => {
  const session = sessionWithAllConditions();
  const result = invalidateForRevision({
    evidence: [evidenceFor(session)],
    change: { type: 'EXPAND_AUTHORITY' },
    rootBaselineHash: session.root_baseline_hash,
  });
  assert.equal(result.requires_preflight, true);
  assert.equal(result.root_baseline_hash, session.root_baseline_hash);
  assert.equal(result.root_baseline_preserved, true);
});

test('reviewer text and executor green cannot certify completion', () => {
  const result = completionLevel({
    session: sessionWithAllConditions(),
    evidence: [{ source: 'reviewer', result: 'pass' }, { source: 'executor', result: 'all_green' }],
    bypasses: [],
  });
  assert.equal(result.level, 'candidate');
  assert.match(result.reason_codes.join(','), /CONTROLLER_EVIDENCE_MISSING/);
});

test('valid evidence with a control-plane bypass is verified but not certified', () => {
  const session = sessionWithAllConditions();
  const result = completionLevel({
    session,
    evidence: [evidenceFor(session)],
    bypasses: [{ type: 'CONTROL_PLANE_BYPASS' }],
    now: '2026-08-11T00:01:00.000Z',
  });
  assert.equal(result.level, 'verified');
  assert.match(result.reason_codes.join(','), /CONTROL_PLANE_BYPASS/);
});

test('all current controller Evidence with no bypass certifies completion', () => {
  const session = sessionWithAllConditions();
  const result = completionLevel({
    session,
    evidence: [evidenceFor(session)],
    bypasses: [],
    now: '2026-08-11T00:01:00.000Z',
  });
  assert.equal(result.level, 'certified');
  assert.deepEqual(result.reason_codes, ['ALL_CONDITIONS_CERTIFIED']);
});

test('completion accepts current runtime and artifact bindings but rejects drift', () => {
  const session = sessionWithAllConditions();
  const runtime = { kind: 'runtime', id: 'codex-runtime', sha256: 'd'.repeat(64) };
  const evidence = evidenceFor(session, { inputHashes: conditionInputs(session, [runtime]) });
  const currentInputsByCondition = { 'condition-tests': [runtime] };
  assert.equal(completionLevel({
    session,
    evidence: [evidence],
    bypasses: [],
    currentInputsByCondition,
    now: '2026-08-11T00:01:00.000Z',
  }).level, 'certified');
  currentInputsByCondition['condition-tests'][0].sha256 = 'e'.repeat(64);
  assert.equal(completionLevel({
    session,
    evidence: [evidence],
    bypasses: [],
    currentInputsByCondition,
    now: '2026-08-11T00:01:00.000Z',
  }).level, 'candidate');
});
