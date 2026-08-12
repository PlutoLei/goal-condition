import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { compileDraft, recordConfirmation } from '../src/compiler.mjs';
import { hashDesignRevision, transitionSession } from '../src/domain.mjs';
import {
  assertAttemptManifest,
  assertProjectionCoverage,
  projectAttempt,
} from '../src/projector.mjs';
import { validateContract } from '../../scripts/lib/contract.mjs';
import { validDraft } from './helpers.mjs';

function digest(bytes) {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

function confirmedSession({ mutateDraft } = {}) {
  const draft = validDraft();
  mutateDraft?.(draft);
  const compiled = compileDraft(draft);
  assert.equal(compiled.gaps.length, 0);
  const receipt = recordConfirmation({
    session: compiled.session,
    observed: {
      authorization_hash: compiled.session.authorization_hash,
      thread_id: 'thread-projector',
      message_ref: 'message-confirmed',
      source: 'codex-task',
      confirmed_at: '2026-08-11T00:00:00.000Z',
    },
  });
  return transitionSession(compiled.session, { type: 'AUTHORIZATION_CONFIRMED', receipt });
}

test('every active Condition maps to contract, runtime context, verifier, and evidence dependencies', () => {
  const session = confirmedSession();
  const result = projectAttempt({
    session,
    designRevision: session.design_revisions.at(-1),
    attemptId: 'attempt-1',
  });
  assert.equal(result.projectionProof.value.conditions.length, 1);
  assert.deepEqual(Object.keys(result.projectionProof.value.conditions[0]).sort(), [
    'condition_id',
    'contract_location',
    'evidence_dependencies',
    'runtime_context_pointer',
    'verifier_id',
  ]);
  assert.equal(result.projectionProof.value.conditions[0].condition_id, 'condition-tests');
});

test('an unmapped Condition blocks projection coverage', () => {
  const conditions = confirmedSession().design_revisions.at(-1).conditions;
  assert.throws(
    () => assertProjectionCoverage({ conditions, mappings: [] }),
    (error) => error.code === 'PROJECTION_COVERAGE_INCOMPLETE',
  );
});

test('AttemptManifest remains closed-world while the envelope stays Codex-only', () => {
  const session = confirmedSession();
  const result = projectAttempt({
    session,
    designRevision: session.design_revisions.at(-1),
    attemptId: 'attempt-1',
  });
  assert.deepEqual(validateContract(result.manifest), []);
  assert.deepEqual(Object.keys(result.envelope).sort(), [
    'context_package_ref',
    'manifest',
    'projection_proof_ref',
    'session_binding',
  ]);
  assert.equal('session_binding' in result.manifest, false);
  assert.equal(result.manifest.runtime, 'codex');
});

test('invalid AttemptManifest fails with a format-neutral controller error', () => {
  assert.throws(
    () => assertAttemptManifest({ version: 1, runtime: 'codex' }),
    (error) => error.code === 'ATTEMPT_MANIFEST_INVALID'
      && Array.isArray(error.diagnostics)
      && error.diagnostics.length > 0,
  );
});

test('production projection surface does not expose legacy manifest terminology', () => {
  const sources = [
    new URL('../src/projector.mjs', import.meta.url),
    new URL('../src/execution.mjs', import.meta.url),
    new URL('../src/cli.mjs', import.meta.url),
  ].map((path) => readFileSync(path, 'utf8')).join('\n');
  assert.doesNotMatch(sources, /V1_PROJECTION_INVALID|v1 manifest|legacy Codex/i);
});

test('non-goals and hard prohibitions remain visible in every Attempt projection', () => {
  const session = confirmedSession();
  const result = projectAttempt({
    session,
    designRevision: session.design_revisions.at(-1),
    attemptId: 'attempt-1',
  });
  assert.deepEqual(result.contextPackage.value.non_goals, session.non_goals);
  assert.deepEqual(
    result.contextPackage.value.hard_prohibitions,
    session.authority_revisions.at(-1).authority.hard_prohibitions,
  );
  assert.ok(result.manifest.constraints.some((entry) => entry.rule === 'network-deny'));
});

test('long conditions do not inflate the native objective', () => {
  const session = confirmedSession({
    mutateDraft(draft) {
      draft.initial_design.conditions[0].rule = 'x'.repeat(6000);
    },
  });
  const result = projectAttempt({
    session,
    designRevision: session.design_revisions.at(-1),
    attemptId: 'attempt-1',
  });
  assert.equal(result.manifest.objective, session.goal.statement);
  assert.ok(Buffer.byteLength(result.manifest.objective, 'utf8') < 4000);
  assert.ok(Buffer.byteLength(result.contextPackage.bytes, 'utf8') > 4000);
  assert.equal(result.contextPackage.sha256, digest(result.contextPackage.bytes));
});

test('projection is deterministic and hash-binds context plus proof', () => {
  const session = confirmedSession();
  const input = {
    session,
    designRevision: session.design_revisions.at(-1),
    attemptId: 'attempt-1',
  };
  assert.deepEqual(projectAttempt(input), projectAttempt(structuredClone(input)));
});

test('condition kinds map to AttemptManifest constraints, judgment, and success criteria', () => {
  const session = confirmedSession({
    mutateDraft(draft) {
      const success = draft.initial_design.conditions[0];
      const judgment = structuredClone(success);
      judgment.id = 'condition-review';
      judgment.kind = 'judgment';
      judgment.verifier.id = 'verify-review';
      judgment.projection.criterion_id = 'judgment-review';
      const invariant = structuredClone(success);
      invariant.id = 'condition-boundary';
      invariant.kind = 'invariant';
      invariant.verifier.id = 'verify-boundary';
      invariant.projection.criterion_id = 'constraint-boundary';
      draft.initial_design.conditions.push(judgment, invariant);
    },
  });
  const result = projectAttempt({
    session,
    designRevision: session.design_revisions.at(-1),
    attemptId: 'attempt-1',
  });
  const locations = Object.fromEntries(
    result.projectionProof.value.conditions.map((entry) => [entry.condition_id, entry.contract_location]),
  );
  assert.match(locations['condition-tests'], /^success_criteria\[/);
  assert.match(locations['condition-review'], /^judgment_criteria\[/);
  assert.match(locations['condition-boundary'], /^constraints\[/);
  assert.equal(new Set(result.manifest.postflight.map((entry) => entry.id)).size, 3);
  assert.deepEqual(validateContract(result.manifest), []);
});

test('verifier IDs may be shared but map to one postflight command', () => {
  const session = confirmedSession({
    mutateDraft(draft) {
      const second = structuredClone(draft.initial_design.conditions[0]);
      second.id = 'condition-second';
      second.projection.criterion_id = 'success-second';
      draft.initial_design.conditions.push(second);
    },
  });
  const result = projectAttempt({
    session,
    designRevision: session.design_revisions.at(-1),
    attemptId: 'attempt-1',
  });
  assert.equal(result.manifest.postflight.length, 1);
  assert.deepEqual(validateContract(result.manifest), []);
});

test('an active budget above confirmed maximum fails before artifact projection', () => {
  const session = confirmedSession({
    mutateDraft(draft) {
      draft.authority.maximum_budget = 10;
      draft.initial_design.active_boundary.budget = 5;
    },
  });
  const design = structuredClone(session.design_revisions.at(-1));
  design.active_boundary.budget = 20;
  design.design_revision_hash = hashDesignRevision(design);
  assert.throws(
    () => projectAttempt({ session, designRevision: design, attemptId: 'attempt-1' }),
    (error) => error.code === 'BOUNDARY_OUTSIDE_AUTHORITY',
  );
});
