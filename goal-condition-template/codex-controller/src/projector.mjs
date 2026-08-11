import { createHash } from 'node:crypto';

import { canonicalJson, validateContract } from '../../scripts/lib/contract.mjs';
import {
  assertDesignWithinAuthority,
  hashAttempt,
  hashDesignRevision,
} from './domain.mjs';
import { exactFields } from './values.mjs';

const ID = /^[a-z0-9][a-z0-9-]*$/;
const MAPPING_FIELDS = Object.freeze([
  'condition_id',
  'contract_location',
  'runtime_context_pointer',
  'verifier_id',
  'evidence_dependencies',
]);

function projectionError(code, message, diagnostics) {
  const error = new Error(message);
  error.code = code;
  if (diagnostics !== undefined) error.diagnostics = diagnostics;
  return error;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

function artifact(value) {
  const bytes = canonicalJson(value);
  return {
    value,
    bytes,
    sha256: sha256(bytes),
    byte_length: Buffer.byteLength(bytes, 'utf8'),
  };
}

function editableDesign(revision) {
  return {
    active_boundary: revision.active_boundary,
    conditions: revision.conditions,
    context_dependencies: revision.context_dependencies,
    projection_version: revision.projection_version,
    reason: revision.reason,
  };
}

function uniqueControllerId(base, used) {
  let candidate = base;
  let suffix = 1;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

function verifierCommand(verifier) {
  return {
    id: verifier.id,
    type: 'command',
    cwd: verifier.cwd,
    argv: structuredClone(verifier.argv),
    capture: verifier.capture,
  };
}

function sameCommand(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function budgetProjection(boundary) {
  if (boundary.budget === null) return undefined;
  if (!(Number.isFinite(boundary.budget) && boundary.budget > 0)) {
    throw projectionError('BUDGET_NOT_PROJECTABLE', 'v1 can project only a positive explicit budget');
  }
  return { user_provided: true, max_cost_usd: boundary.budget };
}

function buildManifest(session, design) {
  if (Buffer.byteLength(session.goal.statement, 'utf8') >= 4000) {
    throw projectionError('NATIVE_OBJECTIVE_TOO_LONG', 'the stable Goal itself exceeds the Codex objective limit');
  }
  const usedIds = new Set(design.context_dependencies.map((dependency) => dependency.id));
  const judgmentCriteria = [];
  const successCriteria = [];
  const constraints = [];
  const postflight = [];
  const verifierById = new Map();
  const mappings = [];

  design.conditions.forEach((condition, conditionIndex) => {
    if (usedIds.has(condition.projection.criterion_id)) {
      throw projectionError('PROJECTION_ID_CONFLICT', `criterion id ${condition.projection.criterion_id} is not unique`);
    }
    usedIds.add(condition.projection.criterion_id);
    let contractLocation;
    if (condition.kind === 'success') {
      contractLocation = `success_criteria[${successCriteria.length}]`;
      successCriteria.push({
        id: condition.projection.criterion_id,
        command: condition.projection.command,
        expected: condition.projection.expected,
      });
    } else if (condition.kind === 'judgment') {
      contractLocation = `judgment_criteria[${judgmentCriteria.length}]`;
      judgmentCriteria.push({
        id: condition.projection.criterion_id,
        rule: condition.rule,
        why: condition.projection.expected,
      });
    } else if (condition.kind === 'invariant') {
      contractLocation = `constraints[${constraints.length}]`;
      constraints.push({
        id: condition.projection.criterion_id,
        rule: condition.rule,
        enforcement: 'audit_only',
      });
    } else {
      throw projectionError('CONDITION_KIND_INVALID', `condition ${condition.id} has an unknown kind`);
    }

    const command = verifierCommand(condition.verifier);
    const existing = verifierById.get(command.id);
    if (existing !== undefined && !sameCommand(existing, command)) {
      throw projectionError('VERIFIER_ID_CONFLICT', `verifier ${command.id} has conflicting definitions`);
    }
    if (existing === undefined) {
      if (usedIds.has(command.id)) {
        throw projectionError('PROJECTION_ID_CONFLICT', `verifier id ${command.id} is not unique`);
      }
      usedIds.add(command.id);
      verifierById.set(command.id, command);
      postflight.push(command);
    }
    mappings.push({
      condition_id: condition.id,
      contract_location: contractLocation,
      runtime_context_pointer: `/conditions/${conditionIndex}`,
      verifier_id: condition.verifier.id,
      evidence_dependencies: [
        ...condition.depends_on.map((id) => `condition:${id}`),
        ...design.context_dependencies.map((dependency) => `context:${dependency.id}`),
      ],
    });
  });

  if (judgmentCriteria.length === 0) {
    judgmentCriteria.push({
      id: uniqueControllerId('controller-goal-alignment', usedIds),
      rule: 'The attempt remains bound to the confirmed Goal and active design.',
      why: 'The v1 judgment gate must not infer a different objective.',
    });
  }
  const authority = session.authority_revisions.at(-1).authority;
  for (const prohibition of authority.hard_prohibitions) {
    constraints.push({
      id: uniqueControllerId('controller-hard-prohibition', usedIds),
      rule: prohibition,
      enforcement: 'audit_only',
    });
  }
  const preflight = design.active_boundary.target_roots.map((target, index) => ({
    id: uniqueControllerId(`controller-preflight-root-${index + 1}`, usedIds),
    type: 'path',
    target,
    require: 'directory',
  }));
  const manifest = {
    version: 1,
    runtime: 'codex',
    objective: session.goal.statement,
    context_sources: design.context_dependencies.map((dependency) => ({
      id: dependency.id,
      path: dependency.path,
      sha256: dependency.sha256,
    })),
    target_roots: structuredClone(design.active_boundary.target_roots),
    judgment_criteria: judgmentCriteria,
    success_criteria: successCriteria,
    constraints,
    allowed_mutations: {
      files: design.active_boundary.actions.includes('write')
        ? design.active_boundary.target_roots.map((root) => `${root}/**`)
        : [],
      git: [],
      external: structuredClone(design.active_boundary.external_effects),
    },
    preflight,
    postflight,
  };
  const budget = budgetProjection(design.active_boundary);
  if (budget !== undefined) manifest.budget = budget;
  return { manifest, mappings };
}

export function assertProjectionCoverage({ conditions, mappings }) {
  if (!Array.isArray(conditions) || !Array.isArray(mappings)) {
    throw projectionError('PROJECTION_COVERAGE_INCOMPLETE', 'conditions and mappings must be arrays');
  }
  const conditionIds = conditions.map((condition) => condition.id);
  const mappingIds = [];
  for (const mapping of mappings) {
    try {
      exactFields(mapping, MAPPING_FIELDS, 'projection_mapping');
    } catch {
      throw projectionError('PROJECTION_COVERAGE_INCOMPLETE', 'a mapping has undeclared fields');
    }
    for (const field of ['condition_id', 'contract_location', 'runtime_context_pointer', 'verifier_id']) {
      if (typeof mapping[field] !== 'string' || mapping[field].length === 0) {
        throw projectionError('PROJECTION_COVERAGE_INCOMPLETE', `mapping ${field} is missing`);
      }
    }
    if (!Array.isArray(mapping.evidence_dependencies)) {
      throw projectionError('PROJECTION_COVERAGE_INCOMPLETE', 'evidence dependencies must be an array');
    }
    mappingIds.push(mapping.condition_id);
  }
  if (new Set(conditionIds).size !== conditionIds.length
    || new Set(mappingIds).size !== mappingIds.length
    || conditionIds.length !== mappingIds.length
    || conditionIds.some((id) => !mappingIds.includes(id))
    || mappingIds.some((id) => !conditionIds.includes(id))) {
    throw projectionError('PROJECTION_COVERAGE_INCOMPLETE', 'every active Condition needs exactly one mapping');
  }
  return true;
}

export function projectAttempt({ session, designRevision, attemptId }) {
  if (session.status !== 'Ready' || session.confirmation_receipts.length === 0) {
    throw projectionError('SESSION_NOT_READY', 'attempt projection requires a confirmed Ready session');
  }
  if (typeof attemptId !== 'string' || !ID.test(attemptId)) {
    throw projectionError('ATTEMPT_ID_INVALID', 'attemptId must be a stable kebab-case id');
  }
  if (designRevision.design_revision_hash !== hashDesignRevision(designRevision)) {
    throw projectionError('DESIGN_HASH_MISMATCH', 'design revision bytes do not match their hash');
  }
  const authority = session.authority_revisions.at(-1).authority;
  const design = editableDesign(designRevision);
  assertDesignWithinAuthority({ goal: session.goal, authority, design });

  const { manifest, mappings } = buildManifest(session, design);
  assertProjectionCoverage({ conditions: design.conditions, mappings });
  const diagnostics = validateContract(manifest);
  if (diagnostics.length > 0) {
    throw projectionError(
      'V1_PROJECTION_INVALID',
      'projected v1 manifest failed closed-world validation',
      diagnostics.map((diagnostic) => diagnostic.code),
    );
  }

  const sessionBinding = {
    session_id: session.session_id,
    authorization_hash: session.authorization_hash,
    design_revision_hash: designRevision.design_revision_hash,
    attempt_id: attemptId,
    root_baseline_hash: session.root_baseline_hash,
  };
  const contextPackage = artifact({
    package_version: 1,
    session_binding: sessionBinding,
    goal: session.goal,
    non_goals: session.non_goals,
    hard_prohibitions: authority.hard_prohibitions,
    active_boundary: design.active_boundary,
    conditions: design.conditions,
    context_dependencies: design.context_dependencies,
    controller_instructions: [
      'Treat this package as the hash-bound execution design for this Attempt.',
      'Propose typed revisions when evidence exposes a gap; do not rewrite Goal or Authority.',
      'Runtime success is only a candidate and cannot self-certify completion.',
    ],
  });
  const projectionProof = artifact({
    proof_version: 1,
    session_binding: sessionBinding,
    conditions: mappings,
  });
  const envelope = {
    session_binding: sessionBinding,
    manifest,
    context_package_ref: {
      sha256: contextPackage.sha256,
      byte_length: contextPackage.byte_length,
    },
    projection_proof_ref: {
      sha256: projectionProof.sha256,
      byte_length: projectionProof.byte_length,
    },
  };
  const attemptHash = hashAttempt({
    session_binding: sessionBinding,
    manifest,
    context_package_ref: envelope.context_package_ref,
    projection_proof_ref: envelope.projection_proof_ref,
    preflight: manifest.preflight,
    postflight: manifest.postflight,
  });
  return {
    envelope,
    manifest,
    contextPackage,
    projectionProof,
    attemptHash,
  };
}
