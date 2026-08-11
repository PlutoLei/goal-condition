import { isAbsolute, relative, resolve } from 'node:path';

import { digestCanonical, exactFields } from './values.mjs';

const ID = /^[a-z0-9][a-z0-9-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RISK_ORDER = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });

const DRAFT_FIELDS = Object.freeze([
  'session_id',
  'goal',
  'non_goals',
  'root_baseline',
  'authority',
  'initial_design',
  'predecessor_session_id',
]);
const GOAL_FIELDS = Object.freeze(['statement', 'deliverables']);
const DELIVERABLE_FIELDS = Object.freeze(['id', 'description']);
const ROOT_BASELINE_FIELDS = Object.freeze(['kind', 'digest']);
const AUTHORITY_FIELDS = Object.freeze([
  'target_roots',
  'actions',
  'external_effects',
  'secret_refs',
  'destructive',
  'maximum_risk',
  'maximum_budget',
  'hard_prohibitions',
]);
const BOUNDARY_FIELDS = Object.freeze([
  'target_roots',
  'actions',
  'external_effects',
  'secret_refs',
  'destructive',
  'risk',
  'budget',
]);
const INITIAL_DESIGN_FIELDS = Object.freeze([
  'active_boundary',
  'conditions',
  'context_dependencies',
  'projection_version',
  'reason',
]);
const CONDITION_FIELDS = Object.freeze([
  'id',
  'kind',
  'rule',
  'deliverable_ref',
  'verifier',
  'projection',
  'depends_on',
  'introduced_by',
  'strengthens',
]);
const VERIFIER_FIELDS = Object.freeze(['id', 'type', 'cwd', 'argv', 'capture']);
const PROJECTION_FIELDS = Object.freeze(['criterion_id', 'command', 'expected']);
const CONTEXT_DEPENDENCY_FIELDS = Object.freeze(['id', 'path', 'sha256']);
const SESSION_FIELDS = Object.freeze([
  'schema_version',
  'session_id',
  'revision',
  'status',
  'goal',
  'non_goals',
  'goal_hash',
  'root_baseline',
  'root_baseline_hash',
  'authority_revisions',
  'authorization_hash',
  'design_revisions',
  'attempts',
  'evidence',
  'confirmation_receipts',
  'decision_ledger',
  'predecessor_session_id',
  'successor_session_id',
]);
const AUTHORITY_REVISION_FIELDS = Object.freeze([
  'revision',
  'authority',
  'previous_authority_revision_hash',
  'authority_revision_hash',
]);
const DESIGN_REVISION_FIELDS = Object.freeze([
  'revision',
  'active_boundary',
  'conditions',
  'context_dependencies',
  'projection_version',
  'reason',
  'previous_design_revision_hash',
  'design_revision_hash',
]);

export const GOAL_SESSION_STATUSES = Object.freeze([
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

function domainError(code, message, path) {
  const error = new Error(message);
  error.code = code;
  if (path !== undefined) error.path = path;
  return error;
}

function nonEmptyString(value, path) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw domainError('STRING_REQUIRED', `${path} must be a non-empty string`, path);
  }
}

function stableId(value, path) {
  nonEmptyString(value, path);
  if (!ID.test(value)) throw domainError('ID_INVALID', `${path} must be a stable kebab-case id`, path);
}

function stringArray(value, path, { min = 0, unique = true } = {}) {
  if (!Array.isArray(value) || value.length < min) {
    throw domainError('ARRAY_REQUIRED', `${path} must contain at least ${min} item(s)`, path);
  }
  value.forEach((entry, index) => nonEmptyString(entry, `${path}[${index}]`));
  if (unique && new Set(value).size !== value.length) {
    throw domainError('DUPLICATE_VALUE', `${path} must not contain duplicates`, path);
  }
}

function finiteBudget(value, path) {
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    throw domainError('BUDGET_INVALID', `${path} must be null or a non-negative finite number`, path);
  }
}

function absoluteRoots(value, path, { min = 0 } = {}) {
  stringArray(value, path, { min });
  value.forEach((entry, index) => {
    if (!isAbsolute(entry) || resolve(entry) !== entry) {
      throw domainError('ABSOLUTE_PATH_REQUIRED', `${path}[${index}] must be normalized and absolute`, `${path}[${index}]`);
    }
  });
}

function isInside(root, candidate) {
  const delta = relative(root, candidate);
  return delta === '' || (!delta.startsWith('..') && !isAbsolute(delta));
}

function subset(values, maximum) {
  const allowed = new Set(maximum);
  return values.every((value) => allowed.has(value));
}

function validateGoal(goal, path = 'goal') {
  exactFields(goal, GOAL_FIELDS, path);
  nonEmptyString(goal.statement, `${path}.statement`);
  if (!Array.isArray(goal.deliverables) || goal.deliverables.length === 0) {
    throw domainError('DELIVERABLE_REQUIRED', `${path}.deliverables must not be empty`, `${path}.deliverables`);
  }
  const ids = new Set();
  goal.deliverables.forEach((deliverable, index) => {
    const deliverablePath = `${path}.deliverables[${index}]`;
    exactFields(deliverable, DELIVERABLE_FIELDS, deliverablePath);
    stableId(deliverable.id, `${deliverablePath}.id`);
    nonEmptyString(deliverable.description, `${deliverablePath}.description`);
    if (ids.has(deliverable.id)) throw domainError('DUPLICATE_ID', `duplicate deliverable ${deliverable.id}`, deliverablePath);
    ids.add(deliverable.id);
  });
  return ids;
}

function validateRootBaseline(rootBaseline, path = 'root_baseline') {
  exactFields(rootBaseline, ROOT_BASELINE_FIELDS, path);
  nonEmptyString(rootBaseline.kind, `${path}.kind`);
  if (typeof rootBaseline.digest !== 'string' || !SHA256.test(rootBaseline.digest)) {
    throw domainError('SHA256_INVALID', `${path}.digest must be lowercase SHA-256`, `${path}.digest`);
  }
}

function validateAuthority(authority, path = 'authority') {
  exactFields(authority, AUTHORITY_FIELDS, path);
  absoluteRoots(authority.target_roots, `${path}.target_roots`, { min: 1 });
  stringArray(authority.actions, `${path}.actions`, { min: 1 });
  stringArray(authority.external_effects, `${path}.external_effects`);
  stringArray(authority.secret_refs, `${path}.secret_refs`);
  if (typeof authority.destructive !== 'boolean') {
    throw domainError('BOOLEAN_REQUIRED', `${path}.destructive must be boolean`, `${path}.destructive`);
  }
  if (!(authority.maximum_risk in RISK_ORDER)) {
    throw domainError('RISK_INVALID', `${path}.maximum_risk is invalid`, `${path}.maximum_risk`);
  }
  finiteBudget(authority.maximum_budget, `${path}.maximum_budget`);
  stringArray(authority.hard_prohibitions, `${path}.hard_prohibitions`);
}

function validateBoundary(boundary, authority, path = 'active_boundary') {
  exactFields(boundary, BOUNDARY_FIELDS, path);
  absoluteRoots(boundary.target_roots, `${path}.target_roots`, { min: 1 });
  stringArray(boundary.actions, `${path}.actions`, { min: 1 });
  stringArray(boundary.external_effects, `${path}.external_effects`);
  stringArray(boundary.secret_refs, `${path}.secret_refs`);
  if (typeof boundary.destructive !== 'boolean') {
    throw domainError('BOOLEAN_REQUIRED', `${path}.destructive must be boolean`, `${path}.destructive`);
  }
  if (!(boundary.risk in RISK_ORDER)) {
    throw domainError('RISK_INVALID', `${path}.risk is invalid`, `${path}.risk`);
  }
  finiteBudget(boundary.budget, `${path}.budget`);

  const rootsInside = boundary.target_roots.every((candidate) =>
    authority.target_roots.some((root) => isInside(root, candidate)));
  const bounded = rootsInside
    && subset(boundary.actions, authority.actions)
    && subset(boundary.external_effects, authority.external_effects)
    && subset(boundary.secret_refs, authority.secret_refs)
    && (!boundary.destructive || authority.destructive)
    && RISK_ORDER[boundary.risk] <= RISK_ORDER[authority.maximum_risk]
    && (boundary.budget === null
      ? true
      : authority.maximum_budget !== null && boundary.budget <= authority.maximum_budget);
  if (!bounded) {
    throw domainError('BOUNDARY_OUTSIDE_AUTHORITY', `${path} exceeds maximum authority`, path);
  }
}

function validateCondition(condition, deliverableIds, path) {
  exactFields(condition, CONDITION_FIELDS, path);
  stableId(condition.id, `${path}.id`);
  if (!['judgment', 'success', 'invariant'].includes(condition.kind)) {
    throw domainError('CONDITION_KIND_INVALID', `${path}.kind is invalid`, `${path}.kind`);
  }
  nonEmptyString(condition.rule, `${path}.rule`);
  stableId(condition.deliverable_ref, `${path}.deliverable_ref`);
  if (!deliverableIds.has(condition.deliverable_ref)) {
    throw domainError('DELIVERABLE_REF_INVALID', `${path}.deliverable_ref is unknown`, `${path}.deliverable_ref`);
  }
  exactFields(condition.verifier, VERIFIER_FIELDS, `${path}.verifier`);
  stableId(condition.verifier.id, `${path}.verifier.id`);
  if (condition.verifier.type !== 'command') {
    throw domainError('VERIFIER_TYPE_INVALID', `${path}.verifier.type is invalid`, `${path}.verifier.type`);
  }
  nonEmptyString(condition.verifier.cwd, `${path}.verifier.cwd`);
  if (!isAbsolute(condition.verifier.cwd) || resolve(condition.verifier.cwd) !== condition.verifier.cwd) {
    throw domainError('ABSOLUTE_PATH_REQUIRED', `${path}.verifier.cwd must be normalized and absolute`, `${path}.verifier.cwd`);
  }
  stringArray(condition.verifier.argv, `${path}.verifier.argv`, { min: 1, unique: false });
  if (!['text', 'json'].includes(condition.verifier.capture)) {
    throw domainError('VERIFIER_CAPTURE_INVALID', `${path}.verifier.capture is invalid`, `${path}.verifier.capture`);
  }
  exactFields(condition.projection, PROJECTION_FIELDS, `${path}.projection`);
  for (const field of PROJECTION_FIELDS) nonEmptyString(condition.projection[field], `${path}.projection.${field}`);
  stringArray(condition.depends_on, `${path}.depends_on`);
  nonEmptyString(condition.introduced_by, `${path}.introduced_by`);
  stringArray(condition.strengthens, `${path}.strengthens`);
}

function validateContextDependencies(dependencies, path) {
  if (!Array.isArray(dependencies)) {
    throw domainError('ARRAY_REQUIRED', `${path} must be an array`, path);
  }
  const ids = new Set();
  dependencies.forEach((dependency, index) => {
    const dependencyPath = `${path}[${index}]`;
    exactFields(dependency, CONTEXT_DEPENDENCY_FIELDS, dependencyPath);
    stableId(dependency.id, `${dependencyPath}.id`);
    if (ids.has(dependency.id)) {
      throw domainError('DUPLICATE_ID', `duplicate context dependency ${dependency.id}`, dependencyPath);
    }
    ids.add(dependency.id);
    nonEmptyString(dependency.path, `${dependencyPath}.path`);
    if (!isAbsolute(dependency.path) || resolve(dependency.path) !== dependency.path) {
      throw domainError(
        'ABSOLUTE_PATH_REQUIRED',
        `${dependencyPath}.path must be normalized and absolute`,
        `${dependencyPath}.path`,
      );
    }
    if (typeof dependency.sha256 !== 'string' || !SHA256.test(dependency.sha256)) {
      throw domainError('SHA256_INVALID', `${dependencyPath}.sha256 must be lowercase SHA-256`, `${dependencyPath}.sha256`);
    }
  });
}

function validateDesign(design, authority, deliverableIds, path = 'initial_design') {
  exactFields(design, INITIAL_DESIGN_FIELDS, path);
  validateBoundary(design.active_boundary, authority, `${path}.active_boundary`);
  if (!Array.isArray(design.conditions) || design.conditions.length === 0) {
    throw domainError('CONDITION_REQUIRED', `${path}.conditions must not be empty`, `${path}.conditions`);
  }
  const ids = new Set();
  design.conditions.forEach((condition, index) => {
    const conditionPath = `${path}.conditions[${index}]`;
    validateCondition(condition, deliverableIds, conditionPath);
    if (ids.has(condition.id)) throw domainError('DUPLICATE_ID', `duplicate condition ${condition.id}`, conditionPath);
    ids.add(condition.id);
  });
  for (const condition of design.conditions) {
    for (const dependency of [...condition.depends_on, ...condition.strengthens]) {
      if (!ids.has(dependency)) {
        throw domainError('CONDITION_REF_INVALID', `condition ${condition.id} refers to ${dependency}`, path);
      }
    }
  }
  validateContextDependencies(design.context_dependencies, `${path}.context_dependencies`);
  nonEmptyString(design.projection_version, `${path}.projection_version`);
  nonEmptyString(design.reason, `${path}.reason`);
}

function authorizationSemantic(goalHash, authorityRevisionHash) {
  return { goal_hash: goalHash, authority_revision_hash: authorityRevisionHash };
}

function designSemantic(design) {
  return {
    active_boundary: design.active_boundary,
    conditions: design.conditions,
    context_dependencies: design.context_dependencies,
    projection_version: design.projection_version,
  };
}

export function hashGoal(goal, nonGoals = []) {
  return digestCanonical({ goal, non_goals: nonGoals });
}

export function hashAuthorityRevision(authorityOrRevision) {
  return digestCanonical(authorityOrRevision.authority ?? authorityOrRevision);
}

export function hashAuthorization(goalHash, authorityRevisionHash) {
  return digestCanonical(authorizationSemantic(goalHash, authorityRevisionHash));
}

export function hashDesignRevision(design) {
  return digestCanonical(designSemantic(design));
}

export function hashAttempt(attempt) {
  const {
    session_binding,
    manifest,
    context_package_ref,
    projection_proof_ref,
    preflight,
    postflight,
  } = attempt;
  return digestCanonical({
    session_binding,
    manifest,
    context_package_ref,
    projection_proof_ref,
    preflight,
    postflight,
  });
}

export function createGoalSession(draft) {
  exactFields(draft, DRAFT_FIELDS, 'draft');
  stableId(draft.session_id, 'session_id');
  const deliverableIds = validateGoal(draft.goal);
  stringArray(draft.non_goals, 'non_goals');
  validateRootBaseline(draft.root_baseline);
  validateAuthority(draft.authority);
  validateDesign(draft.initial_design, draft.authority, deliverableIds);
  if (draft.predecessor_session_id !== undefined && draft.predecessor_session_id !== null) {
    stableId(draft.predecessor_session_id, 'predecessor_session_id');
  }

  const goalHash = hashGoal(draft.goal, draft.non_goals);
  const authorityRevisionHash = hashAuthorityRevision(draft.authority);
  const authorizationHash = hashAuthorization(goalHash, authorityRevisionHash);
  const designRevisionHash = hashDesignRevision(draft.initial_design);
  const session = {
    schema_version: 2,
    session_id: draft.session_id,
    revision: 0,
    status: 'Drafting',
    goal: structuredClone(draft.goal),
    non_goals: structuredClone(draft.non_goals),
    goal_hash: goalHash,
    root_baseline: structuredClone(draft.root_baseline),
    root_baseline_hash: digestCanonical(draft.root_baseline),
    authority_revisions: [
      {
        revision: 1,
        authority: structuredClone(draft.authority),
        previous_authority_revision_hash: null,
        authority_revision_hash: authorityRevisionHash,
      },
    ],
    authorization_hash: authorizationHash,
    design_revisions: [
      {
        revision: 1,
        ...structuredClone(draft.initial_design),
        previous_design_revision_hash: null,
        design_revision_hash: designRevisionHash,
      },
    ],
    attempts: [],
    evidence: [],
    confirmation_receipts: [],
    decision_ledger: [],
    predecessor_session_id: draft.predecessor_session_id ?? null,
    successor_session_id: null,
  };
  const diagnostics = validateGoalSession(session);
  if (diagnostics.length > 0) {
    const [first] = diagnostics;
    throw domainError(first.code, first.message, first.path);
  }
  return session;
}

function diagnosticFrom(error) {
  return {
    code: error.code ?? 'GOAL_SESSION_INVALID',
    path: error.path ?? null,
    message: error.message,
  };
}

export function validateGoalSession(session) {
  const diagnostics = [];
  try {
    exactFields(session, SESSION_FIELDS, 'session');
  } catch (error) {
    diagnostics.push(diagnosticFrom(error));
    return diagnostics;
  }
  if (session.schema_version !== 2) diagnostics.push({ code: 'SCHEMA_VERSION_INVALID', path: 'schema_version' });
  if (!GOAL_SESSION_STATUSES.includes(session.status)) diagnostics.push({ code: 'SESSION_STATUS_INVALID', path: 'status' });
  if (!Number.isSafeInteger(session.revision) || session.revision < 0) diagnostics.push({ code: 'SESSION_REVISION_INVALID', path: 'revision' });

  let deliverableIds;
  try {
    stableId(session.session_id, 'session_id');
    deliverableIds = validateGoal(session.goal);
    stringArray(session.non_goals, 'non_goals');
    validateRootBaseline(session.root_baseline);
  } catch (error) {
    diagnostics.push(diagnosticFrom(error));
  }
  if (session.goal_hash !== hashGoal(session.goal, session.non_goals)) {
    diagnostics.push({ code: 'GOAL_HASH_MISMATCH', path: 'goal_hash' });
  }
  if (session.root_baseline_hash !== digestCanonical(session.root_baseline)) {
    diagnostics.push({ code: 'ROOT_BASELINE_HASH_MISMATCH', path: 'root_baseline_hash' });
  }

  if (!Array.isArray(session.authority_revisions) || session.authority_revisions.length === 0) {
    diagnostics.push({ code: 'AUTHORITY_REVISION_REQUIRED', path: 'authority_revisions' });
  } else {
    session.authority_revisions.forEach((revision, index) => {
      const path = `authority_revisions[${index}]`;
      try {
        exactFields(revision, AUTHORITY_REVISION_FIELDS, path);
        validateAuthority(revision.authority, `${path}.authority`);
        if (revision.authority_revision_hash !== hashAuthorityRevision(revision)) {
          diagnostics.push({ code: 'AUTHORITY_HASH_MISMATCH', path: `${path}.authority_revision_hash` });
        }
      } catch (error) {
        diagnostics.push(diagnosticFrom(error));
      }
    });
    const current = session.authority_revisions.at(-1);
    if (current !== null
      && typeof current === 'object'
      && session.authorization_hash !== hashAuthorization(session.goal_hash, current.authority_revision_hash)) {
      diagnostics.push({ code: 'AUTHORIZATION_HASH_MISMATCH', path: 'authorization_hash' });
    }
  }

  if (!Array.isArray(session.design_revisions) || session.design_revisions.length === 0) {
    diagnostics.push({ code: 'DESIGN_REVISION_REQUIRED', path: 'design_revisions' });
  } else if (session.authority_revisions?.at(-1)?.authority !== undefined && deliverableIds !== undefined) {
    const currentAuthority = session.authority_revisions.at(-1).authority;
    session.design_revisions.forEach((revision, index) => {
      const path = `design_revisions[${index}]`;
      try {
        exactFields(revision, DESIGN_REVISION_FIELDS, path);
        const design = Object.fromEntries(
          INITIAL_DESIGN_FIELDS.map((field) => [field, revision[field]]),
        );
        validateDesign(design, currentAuthority, deliverableIds, path);
        if (revision.design_revision_hash !== hashDesignRevision(revision)) {
          diagnostics.push({ code: 'DESIGN_HASH_MISMATCH', path: `${path}.design_revision_hash` });
        }
      } catch (error) {
        diagnostics.push(diagnosticFrom(error));
      }
    });
  }

  for (const [field, value] of [
    ['attempts', session.attempts],
    ['evidence', session.evidence],
    ['confirmation_receipts', session.confirmation_receipts],
    ['decision_ledger', session.decision_ledger],
  ]) {
    if (!Array.isArray(value)) diagnostics.push({ code: 'ARRAY_REQUIRED', path: field });
  }
  return diagnostics;
}
