import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  GOAL_SESSION_STATUSES,
  createGoalSession,
  hashAttempt,
  hashAuthorization,
  hashDesignRevision,
  validateGoalSession,
} from '../src/domain.mjs';
import { validDraft } from './helpers.mjs';

test('Goal hash is immutable inside a session', () => {
  const session = createGoalSession(validDraft());
  const changed = structuredClone(session);
  changed.goal.statement = 'another goal';
  assert.match(validateGoalSession(changed).map((d) => d.code).join(','), /GOAL_HASH_MISMATCH/);
});

test('active boundary must stay inside confirmed maximum authority', () => {
  const draft = validDraft();
  draft.initial_design.active_boundary.target_roots.push('/srv/not-authorized');
  assert.throws(
    () => createGoalSession(draft),
    (error) => error.code === 'BOUNDARY_OUTSIDE_AUTHORITY',
  );
});

test('conditions keep stable identity and definitions contain no satisfaction flag', () => {
  const condition = validDraft().initial_design.conditions[0];
  assert.equal('satisfied' in condition, false);
  assert.match(condition.id, /^[a-z0-9][a-z0-9-]*$/);
});

test('authorization hash is independent from design revisions', () => {
  const session = createGoalSession(validDraft());
  const changedDesign = structuredClone(session.design_revisions[0]);
  changedDesign.active_boundary.actions = ['read'];
  assert.notEqual(hashDesignRevision(changedDesign), changedDesign.design_revision_hash);
  assert.equal(
    hashAuthorization(session.goal_hash, session.authority_revisions[0].authority_revision_hash),
    session.authorization_hash,
  );
});

test('closed-world draft and nested condition fields reject unknown input', () => {
  const draft = validDraft();
  draft.initial_design.conditions[0].satisfied = true;
  assert.throws(
    () => createGoalSession(draft),
    (error) => error.code === 'UNKNOWN_FIELD' && error.path === 'initial_design.conditions[0]',
  );
});

test('context dependencies are content-bound closed-world records', () => {
  const draft = validDraft();
  draft.initial_design.context_dependencies = [
    { id: 'context-readme', path: '/work/project/README.md', sha256: 'b'.repeat(64) },
  ];
  assert.doesNotThrow(() => createGoalSession(draft));
  draft.initial_design.context_dependencies[0].content = 'unbound bytes';
  assert.throws(
    () => createGoalSession(draft),
    (error) => error.code === 'UNKNOWN_FIELD'
      && error.path === 'initial_design.context_dependencies[0]',
  );
});

test('stored authority and design hashes are checked independently', () => {
  const session = createGoalSession(validDraft());
  const authorityChanged = structuredClone(session);
  authorityChanged.authority_revisions[0].authority.actions = ['read'];
  assert.match(
    validateGoalSession(authorityChanged).map((diagnostic) => diagnostic.code).join(','),
    /AUTHORITY_HASH_MISMATCH/,
  );

  const designChanged = structuredClone(session);
  designChanged.design_revisions[0].conditions[0].rule = 'A weakened rule.';
  assert.match(
    validateGoalSession(designChanged).map((diagnostic) => diagnostic.code).join(','),
    /DESIGN_HASH_MISMATCH/,
  );
});

test('validation reports corrupt nested revisions instead of throwing', () => {
  const session = createGoalSession(validDraft());
  session.authority_revisions = [null];
  let diagnostics;
  assert.doesNotThrow(() => {
    diagnostics = validateGoalSession(session);
  });
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 'OBJECT_REQUIRED'));
});

test('session statuses and attempt hashes are closed and canonical', () => {
  assert.deepEqual(GOAL_SESSION_STATUSES, [
    'Drafting',
    'AwaitingConfirmation',
    'Ready',
    'Running',
    'Evaluating',
    'Revising',
    'AwaitingReauthorization',
    'ReconciliationRequired',
    'Blocked',
    'Complete',
    'Superseded',
  ]);
  const attempt = {
    session_binding: { session_id: 'session-0001', authorization_hash: 'a'.repeat(64) },
    manifest: { version: 1, objective: 'Do the work.' },
    context_package_ref: 'b'.repeat(64),
    projection_proof_ref: 'c'.repeat(64),
    preflight: { ok: true },
    postflight: { ok: true },
  };
  assert.equal(hashAttempt(attempt), hashAttempt(structuredClone(attempt)));
});

test('audit schemas are closed-world and pin the public versions', async () => {
  const sessionSchema = JSON.parse(
    await readFile(new URL('../schema/goal-session-v2.schema.json', import.meta.url), 'utf8'),
  );
  const operationSchema = JSON.parse(
    await readFile(new URL('../schema/revision-operation-v1.schema.json', import.meta.url), 'utf8'),
  );
  assert.equal(sessionSchema.$id, 'https://goal-condition.dev/schema/codex/goal-session-v2.schema.json');
  assert.equal(sessionSchema.additionalProperties, false);
  assert.equal(sessionSchema.properties.schema_version.const, 2);
  assert.equal(sessionSchema.$defs.condition.additionalProperties, false);
  assert.equal(sessionSchema.$defs.authority.additionalProperties, false);
  assert.equal(sessionSchema.$defs.contextDependency.additionalProperties, false);
  assert.equal(operationSchema.$id, 'https://goal-condition.dev/schema/codex/revision-operation-v1.schema.json');
  assert.equal(operationSchema.$defs.operationBase.additionalProperties, false);
  assert.deepEqual(operationSchema.$defs.operationType.enum, [
    'ADD_CONDITION',
    'ADD_AND_VERIFIER',
    'TIGHTEN_TYPED_THRESHOLD',
    'NARROW_ACTIVE_BOUNDARY',
    'EXPAND_WITHIN_AUTHORITY',
    'REFRESH_CONTEXT',
    'REPLACE_EQUIVALENT_VERIFIER',
    'CONTROLLER_CORRECTION',
    'EXPAND_AUTHORITY',
    'WEAKEN_CONDITION',
    'CHANGE_GOAL',
    'UNCLASSIFIED',
  ]);
});
