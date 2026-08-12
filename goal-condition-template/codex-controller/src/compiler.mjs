import { createGoalSession, transitionSession } from './domain.mjs';
import { exactFields } from './values.mjs';

const DRAFT_FIELDS = Object.freeze([
  'session_id',
  'goal',
  'non_goals',
  'root_baseline',
  'authority',
  'initial_design',
  'predecessor_session_id',
]);
const COMPILER_FIELDS = Object.freeze([
  ...DRAFT_FIELDS,
  'discoverable',
  'goal_candidates',
  'preference_options',
]);
const OBSERVED_FIELDS = Object.freeze([
  'authorization_hash',
  'thread_id',
  'message_ref',
  'source',
  'confirmed_at',
]);

function compilerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function gap(code, field, alternatives, decisionRequired) {
  return {
    code,
    field,
    alternatives,
    conservative_default_unavailable: true,
    decision_required: decisionRequired,
  };
}

function distinctGoals(goals) {
  const seen = new Set();
  return goals.filter((goal) => {
    const key = JSON.stringify(goal);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compileGoal(input, draft) {
  if (draft.goal !== undefined) return [];
  const candidates = distinctGoals(input.goal_candidates ?? []);
  if (candidates.length === 1) {
    draft.goal = structuredClone(candidates[0]);
    return [];
  }
  if (candidates.length > 1) {
    return [gap(
      'GOAL_AMBIGUOUS',
      'goal',
      candidates.map((candidate) => candidate.statement),
      'Choose the one Goal whose deliverable should define this GoalSession.',
    )];
  }
  return [gap(
    'GOAL_REQUIRED',
    'goal',
    ['supply one Goal with stable deliverables'],
    'State the single outcome this GoalSession must achieve.',
  )];
}

function conservativeAssumptions(preferences) {
  if (preferences === undefined) return [];
  exactFields(preferences, ['verification_scope'], 'preference_options');
  if (preferences.verification_scope === undefined) return [];
  if (!Array.isArray(preferences.verification_scope)) {
    throw compilerError('PREFERENCE_OPTIONS_INVALID', 'verification_scope must be an array');
  }
  return [{
    code: 'CONSERVATIVE_VERIFICATION_SCOPE',
    field: 'preference_options.verification_scope',
    value: 'full',
  }];
}

function observabilityGaps(draft) {
  const conditions = draft.initial_design?.conditions;
  if (!Array.isArray(conditions)) return [];
  const observableSuccess = conditions.some((condition) =>
    condition?.kind === 'success'
    && condition.verifier?.type === 'command'
    && Array.isArray(condition.verifier.argv)
    && condition.verifier.argv.length > 0);
  if (observableSuccess) return [];
  return [gap(
    'SUCCESS_OBSERVABILITY_REQUIRED',
    'initial_design.conditions',
    ['add a deterministic command verifier', 'supply another controller-observable success mechanism'],
    'Define how the controller can observe the required deliverable independently.',
  )];
}

export function compileDraft(input) {
  exactFields(input, COMPILER_FIELDS, 'compiler_input');
  const draft = Object.fromEntries(
    DRAFT_FIELDS.filter((field) => input[field] !== undefined).map((field) => [field, structuredClone(input[field])]),
  );
  if (input.discoverable !== undefined) {
    exactFields(input.discoverable, DRAFT_FIELDS, 'discoverable');
    for (const field of DRAFT_FIELDS) {
      if (draft[field] === undefined && input.discoverable[field] !== undefined) {
        draft[field] = structuredClone(input.discoverable[field]);
      }
    }
  }

  const gaps = compileGoal(input, draft);
  gaps.push(...observabilityGaps(draft));
  const assumptions = conservativeAssumptions(input.preference_options);
  if (gaps.length > 0) return { session: null, gaps, questions: gaps, assumptions };

  let session;
  try {
    session = transitionSession(createGoalSession(draft), { type: 'DRAFT_COMPILED' });
  } catch (error) {
    const compilationGap = gap(
      error.code ?? 'DRAFT_INVALID',
      error.path ?? 'draft',
      ['supply a closed-world structured value'],
      'Resolve the invalid field before authorization can be compiled.',
    );
    return {
      session: null,
      gaps: [compilationGap],
      questions: [compilationGap],
      assumptions,
    };
  }
  return { session, gaps: [], questions: [], assumptions };
}

function bullet(values, empty = 'None') {
  if (values.length === 0) return `- ${empty}`;
  return values.map((value) => `- ${value}`).join('\n');
}

export function renderAuthorizationPreview(session) {
  const authority = session.authority_revisions.at(-1).authority;
  const design = session.design_revisions[0];
  const shortFingerprint = session.authorization_hash.slice(0, 12);
  const conditions = design.conditions.map((condition) =>
    `- ${condition.id} [${condition.kind}]: ${condition.rule} (verifier: ${condition.verifier.id})`).join('\n');
  const contextDependencies = design.context_dependencies.map((dependency) =>
    `${dependency.id}: ${dependency.path} (content SHA-256 ${dependency.sha256})`);
  const markdown = [
    '# GoalSession Authorization',
    '',
    `Fingerprint: \`${shortFingerprint}\``,
    '',
    '## Goal',
    '',
    session.goal.statement,
    '',
    'Deliverables:',
    bullet(session.goal.deliverables.map((item) => `${item.id}: ${item.description}`)),
    '',
    '## Non-goals',
    '',
    bullet(session.non_goals),
    '',
    '## Maximum Authority',
    '',
    `Target roots:\n${bullet(authority.target_roots)}`,
    `Actions:\n${bullet(authority.actions)}`,
    `External effects:\n${bullet(authority.external_effects)}`,
    `Secret references:\n${bullet(authority.secret_refs)}`,
    `Destructive operations: ${authority.destructive ? 'allowed' : 'not allowed'}`,
    `Maximum risk: ${authority.maximum_risk}`,
    `Maximum budget: ${authority.maximum_budget ?? 'not granted'}`,
    '',
    '## Hard Prohibitions',
    '',
    bullet(authority.hard_prohibitions),
    '',
    '## Initial Active Boundary',
    '',
    `Target roots:\n${bullet(design.active_boundary.target_roots)}`,
    `Actions:\n${bullet(design.active_boundary.actions)}`,
    `Risk: ${design.active_boundary.risk}`,
    '',
    '## Initial Conditions',
    '',
    conditions,
    '',
    '## Initial Context Dependencies',
    '',
    bullet(contextDependencies),
    '',
    '## Automatic Design Revisions',
    '',
    bullet([
      'Add or strengthen observable Conditions within existing deliverables.',
      'Narrow the active boundary or expand it only inside Maximum Authority.',
      'Refresh content-bound context with dependent evidence invalidation.',
      'Replace a verifier only with controller-owned parity or mutation proof.',
    ]),
    '',
    '## Reauthorization Triggers',
    '',
    bullet([
      'Change the Goal or deliverable semantics.',
      'Expand Maximum Authority, risk, budget, secrets, external writes, or destructive actions.',
      'Weaken a Condition or abandon a Hard Prohibition.',
      'Apply a change the typed policy cannot classify.',
    ]),
    '',
  ].join('\n');
  return { markdown, short_fingerprint: shortFingerprint };
}

export function recordConfirmation({ session, observed }) {
  exactFields(observed, OBSERVED_FIELDS, 'observed_confirmation');
  if (observed.authorization_hash !== session.authorization_hash) {
    throw compilerError('AUTHORIZATION_HASH_MISMATCH', 'observed confirmation does not match this authorization');
  }
  if (!['codex-task', 'user_message'].includes(observed.source)) {
    throw compilerError('CONFIRMATION_SOURCE_INVALID', 'confirmation source must be an observed user message');
  }
  for (const field of ['thread_id', 'message_ref']) {
    if (typeof observed[field] !== 'string' || observed[field].length === 0) {
      throw compilerError('CONFIRMATION_REFERENCE_REQUIRED', `${field} is required`);
    }
  }
  const confirmedAt = observed.confirmed_at ?? new Date().toISOString();
  if (Number.isNaN(new Date(confirmedAt).getTime())) {
    throw compilerError('CONFIRMATION_TIME_INVALID', 'confirmed_at must be an ISO timestamp');
  }
  return {
    receipt_version: 1,
    session_id: session.session_id,
    goal_hash: session.goal_hash,
    authority_revision_hash: session.authority_revisions.at(-1).authority_revision_hash,
    authorization_hash: session.authorization_hash,
    presented_design_hash: session.design_revisions.at(-1).design_revision_hash,
    short_fingerprint: session.authorization_hash.slice(0, 12),
    confirmed_at: new Date(confirmedAt).toISOString(),
    thread_id: observed.thread_id,
    turn_or_message_ref: observed.message_ref,
    confirmation_source: observed.source,
  };
}
