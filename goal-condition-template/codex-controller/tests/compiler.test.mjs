import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileDraft,
  recordConfirmation,
  renderAuthorizationPreview,
} from '../src/compiler.mjs';
import { validCompilerInput, validDraft } from './helpers.mjs';

test('compiler owns the machine-global session identifier', () => {
  const result = compileDraft(validCompilerInput());
  assert.match(result.session.session_id, /^session-[0-9a-f]{32}$/);
  assert.throws(
    () => compileDraft(validDraft()),
    (error) => error.code === 'UNKNOWN_FIELD',
  );
});

test('complete structured input compiles without questions', () => {
  const result = compileDraft(validCompilerInput());
  assert.equal(result.gaps.length, 0);
  assert.equal(result.questions.length, 0);
  assert.equal(result.session.schema_version, 2);
});

test('discoverable missing information is filled instead of asked', () => {
  const input = validCompilerInput();
  delete input.non_goals;
  input.discoverable = { non_goals: ['Do not publish or deploy.'] };
  const result = compileDraft(input);
  assert.equal(result.gaps.length, 0);
  assert.deepEqual(result.session.non_goals, ['Do not publish or deploy.']);
});

test('two materially different Goal candidates return one blocking CompilationGap', () => {
  const input = validCompilerInput();
  delete input.goal;
  input.goal_candidates = [
    {
      statement: 'Implement the parser.',
      deliverables: [{ id: 'delivery-parser', description: 'Parser code.' }],
    },
    {
      statement: 'Publish the release notes.',
      deliverables: [{ id: 'delivery-notes', description: 'Published notes.' }],
    },
  ];
  const result = compileDraft(input);
  assert.equal(result.session, null);
  assert.equal(result.gaps.length, 1);
  assert.deepEqual(Object.keys(result.gaps[0]).sort(), [
    'alternatives',
    'code',
    'conservative_default_unavailable',
    'decision_required',
    'field',
  ]);
  assert.equal(result.gaps[0].code, 'GOAL_AMBIGUOUS');
});

test('preference-only ambiguity records a conservative assumption', () => {
  const input = validCompilerInput();
  input.preference_options = { verification_scope: ['targeted', 'full'] };
  const result = compileDraft(input);
  assert.equal(result.gaps.length, 0);
  assert.deepEqual(result.assumptions, [
    {
      code: 'CONSERVATIVE_VERIFICATION_SCOPE',
      field: 'preference_options.verification_scope',
      value: 'full',
    },
  ]);
});

test('a design with no observable success Condition returns a blocking gap', () => {
  const input = validCompilerInput();
  input.initial_design.conditions[0].kind = 'invariant';
  const result = compileDraft(input);
  assert.equal(result.session, null);
  assert.equal(result.gaps[0].code, 'SUCCESS_OBSERVABILITY_REQUIRED');
  assert.equal(result.gaps[0].conservative_default_unavailable, true);
});

test('preview shows authorization, initial design, policy summary, and only a short fingerprint', () => {
  const draft = validCompilerInput();
  draft.initial_design.context_dependencies = [
    { id: 'context-readme', path: '/work/project/README.md', sha256: 'b'.repeat(64) },
  ];
  const result = compileDraft(draft);
  const preview = renderAuthorizationPreview(result.session);
  for (const heading of [
    'Goal',
    'Non-goals',
    'Maximum Authority',
    'Hard Prohibitions',
    'Initial Active Boundary',
    'Initial Conditions',
    'Initial Context Dependencies',
    'Automatic Design Revisions',
    'Reauthorization Triggers',
  ]) {
    assert.match(preview.markdown, new RegExp(heading));
  }
  assert.equal(preview.short_fingerprint, result.session.authorization_hash.slice(0, 12));
  assert.match(preview.markdown, new RegExp(preview.short_fingerprint));
  assert.doesNotMatch(preview.markdown, new RegExp(result.session.authorization_hash));
  assert.match(preview.markdown, /context-readme: \/work\/project\/README\.md/);
  assert.match(preview.markdown, new RegExp('b'.repeat(64)));
  assert.doesNotMatch(preview.markdown, /grill/i);
});

test('initial design is presented but not frozen into authorization', () => {
  const first = compileDraft(validCompilerInput());
  const receipt = recordConfirmation({
    session: first.session,
    observed: {
      authorization_hash: first.session.authorization_hash,
      thread_id: 'thread-synthetic',
      message_ref: 'message-1',
      source: 'codex-task',
      confirmed_at: '2026-08-11T00:00:00.000Z',
    },
  });
  assert.equal(receipt.authorization_hash, first.session.authorization_hash);
  assert.equal(receipt.presented_design_hash, first.session.design_revisions[0].design_revision_hash);
  assert.notEqual(receipt.authorization_hash, receipt.presented_design_hash);
  assert.equal(receipt.short_fingerprint.length, 12);
});

test('confirmation with a wrong authorization hash fails closed', () => {
  const first = compileDraft(validCompilerInput());
  assert.throws(
    () => recordConfirmation({
      session: first.session,
      observed: {
        authorization_hash: 'f'.repeat(64),
        thread_id: 'thread-synthetic',
        message_ref: 'message-1',
        source: 'codex-task',
      },
    }),
    (error) => error.code === 'AUTHORIZATION_HASH_MISMATCH',
  );
});
