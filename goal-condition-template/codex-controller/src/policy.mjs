import {
  assertDesignWithinAuthority,
  hashDesignRevision,
} from './domain.mjs';
import { canonicalJson } from '../../scripts/lib/contract.mjs';
import { exactFields } from './values.mjs';

const OPERATION_FIELDS = Object.freeze(['version', 'type', 'reason', 'evidence_refs', 'payload']);
const AUTO_TYPES = new Set([
  'ADD_CONDITION',
  'ADD_AND_VERIFIER',
  'TIGHTEN_TYPED_THRESHOLD',
  'NARROW_ACTIVE_BOUNDARY',
  'EXPAND_WITHIN_AUTHORITY',
  'REFRESH_CONTEXT',
  'REPLACE_EQUIVALENT_VERIFIER',
  'CONTROLLER_CORRECTION',
]);
const HASH = /^[0-9a-f]{64}$/;
const PAYLOAD_FIELDS = Object.freeze({
  ADD_CONDITION: ['condition'],
  ADD_AND_VERIFIER: ['condition'],
  TIGHTEN_TYPED_THRESHOLD: ['condition_id', 'comparator', 'from', 'to'],
  NARROW_ACTIVE_BOUNDARY: ['active_boundary'],
  EXPAND_WITHIN_AUTHORITY: ['active_boundary'],
  REFRESH_CONTEXT: ['dependency_id', 'prior_hash', 'next_hash'],
  REPLACE_EQUIVALENT_VERIFIER: ['condition_id', 'verifier', 'proof_ref'],
  CONTROLLER_CORRECTION: ['field', 'prior_hash', 'next_value'],
  EXPAND_AUTHORITY: ['authority'],
  WEAKEN_CONDITION: ['condition_id', 'replacement'],
  CHANGE_GOAL: ['goal', 'non_goals'],
  UNCLASSIFIED: ['description'],
});

function result(decision, reasonCodes, nextDesign = null, invalidations = []) {
  return {
    decision,
    reason_codes: reasonCodes,
    next_design: nextDesign,
    invalidations,
  };
}

function currentDesign(session) {
  return session.design_revisions.at(-1);
}

function editableDesign(revision) {
  return {
    active_boundary: structuredClone(revision.active_boundary),
    conditions: structuredClone(revision.conditions),
    context_dependencies: structuredClone(revision.context_dependencies),
    projection_version: revision.projection_version,
    reason: revision.reason,
  };
}

function finalizeAuto(session, operation, design, invalidations) {
  const authority = session.authority_revisions.at(-1).authority;
  try {
    assertDesignWithinAuthority({ goal: session.goal, authority, design });
  } catch (error) {
    if (error.code === 'DELIVERABLE_REF_INVALID') {
      return result('successor_required', ['NEW_DELIVERABLE_REQUIRED']);
    }
    if (error.code === 'BOUNDARY_OUTSIDE_AUTHORITY') {
      return result('reject', ['AUTHORITY_EXPANSION_REQUIRES_EXPLICIT_REVISION']);
    }
    return result('reject', [error.code ?? 'DESIGN_INVALID']);
  }
  const previous = currentDesign(session);
  design.reason = operation.reason;
  const next = {
    revision: previous.revision + 1,
    ...design,
    previous_design_revision_hash: previous.design_revision_hash,
  };
  next.design_revision_hash = hashDesignRevision(next);
  return result('auto_apply', ['TYPED_MONOTONIC_REVISION'], next, invalidations);
}

function setInside(candidate, maximum) {
  const allowed = new Set(maximum);
  return candidate.every((value) => allowed.has(value));
}

function rootInside(candidate, maximum) {
  return maximum.some((root) => candidate === root || candidate.startsWith(`${root}/`));
}

function boundaryNarrows(candidate, current) {
  const risk = { low: 0, medium: 1, high: 2, critical: 3 };
  return candidate.target_roots.every((root) => rootInside(root, current.target_roots))
    && setInside(candidate.actions, current.actions)
    && setInside(candidate.external_effects, current.external_effects)
    && setInside(candidate.secret_refs, current.secret_refs)
    && (!candidate.destructive || current.destructive)
    && risk[candidate.risk] <= risk[current.risk]
    && (candidate.budget === null
      ? current.budget === null
      : current.budget !== null && candidate.budget <= current.budget);
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function operationShape(operation) {
  try {
    exactFields(operation, OPERATION_FIELDS, 'operation');
    if (operation.version !== 1
      || typeof operation.reason !== 'string'
      || operation.reason.length === 0
      || !Array.isArray(operation.evidence_refs)
      || operation.evidence_refs.some((reference) => typeof reference !== 'string' || reference.length === 0)
      || new Set(operation.evidence_refs).size !== operation.evidence_refs.length
      || !(operation.type in PAYLOAD_FIELDS)) return false;
    exactFields(operation.payload, PAYLOAD_FIELDS[operation.type], 'operation.payload');
    if (operation.type === 'REFRESH_CONTEXT'
      && (!HASH.test(operation.payload.prior_hash ?? '') || !HASH.test(operation.payload.next_hash ?? ''))) return false;
    if (['CONTROLLER_CORRECTION'].includes(operation.type)
      && !HASH.test(operation.payload.prior_hash ?? '')) return false;
    return true;
  } catch {
    return false;
  }
}

function thresholdTightens({ comparator, current, from, to }) {
  if (!valuesEqual(current, from)) return false;
  if (comparator === 'gte') return Number.isFinite(to) && to >= current;
  if (comparator === 'lte') return Number.isFinite(to) && to <= current;
  if (comparator === 'eq') return valuesEqual(to, current);
  if (comparator === 'subset') {
    return Array.isArray(current) && Array.isArray(to) && setInside(to, current);
  }
  return false;
}

function evaluateAuto(session, operation, controllerProof) {
  const current = currentDesign(session);
  const design = editableDesign(current);
  const payload = operation.payload;
  if (operation.type === 'ADD_CONDITION' || operation.type === 'ADD_AND_VERIFIER') {
    if (design.conditions.some((condition) => condition.id === payload.condition?.id)) {
      return result('reject', ['CONDITION_ID_CONFLICT']);
    }
    const previousConditions = design.conditions.map((condition) => canonicalJson(condition));
    design.conditions.push(structuredClone(payload.condition));
    const preserved = design.conditions.slice(0, previousConditions.length)
      .every((condition, index) => canonicalJson(condition) === previousConditions[index]);
    if (!preserved
      || design.conditions.length !== previousConditions.length + 1
      || new Set(design.conditions.map((condition) => condition.id)).size !== design.conditions.length) {
      return result('reject', ['CONDITION_APPEND_INVARIANT_FAILED']);
    }
    return finalizeAuto(session, operation, design, [`condition:${payload.condition?.id}`]);
  }
  if (operation.type === 'TIGHTEN_TYPED_THRESHOLD') {
    const condition = design.conditions.find((item) => item.id === payload.condition_id);
    const predicate = condition?.predicate;
    if (predicate === undefined
      || predicate.comparator !== payload.comparator
      || !thresholdTightens({
        comparator: payload.comparator,
        current: predicate.value,
        from: payload.from,
        to: payload.to,
      })) {
      return result('reject', ['TYPED_MONOTONIC_PROOF_FAILED']);
    }
    predicate.value = structuredClone(payload.to);
    return finalizeAuto(session, operation, design, [`condition:${condition.id}`]);
  }
  if (operation.type === 'NARROW_ACTIVE_BOUNDARY') {
    if (!boundaryNarrows(payload.active_boundary, current.active_boundary)) {
      return result('reject', ['BOUNDARY_NOT_NARROWER']);
    }
    design.active_boundary = structuredClone(payload.active_boundary);
    return finalizeAuto(session, operation, design, ['attempt:preflight']);
  }
  if (operation.type === 'EXPAND_WITHIN_AUTHORITY') {
    design.active_boundary = structuredClone(payload.active_boundary);
    return finalizeAuto(session, operation, design, ['attempt:snapshot', 'attempt:preflight']);
  }
  if (operation.type === 'REFRESH_CONTEXT') {
    const dependency = design.context_dependencies.find((item) => item.id === payload.dependency_id);
    if (dependency === undefined
      || dependency.sha256 !== payload.prior_hash
      || controllerProof.context_hash !== payload.next_hash) {
      return result('reject', ['CONTEXT_REFRESH_UNVERIFIED']);
    }
    dependency.sha256 = payload.next_hash;
    return finalizeAuto(session, operation, design, [`context:${dependency.id}`]);
  }
  if (operation.type === 'REPLACE_EQUIVALENT_VERIFIER') {
    return result('reject', ['VERIFIER_EQUIVALENCE_PROOF_REQUIRED']);
  }
  if (operation.type === 'CONTROLLER_CORRECTION') {
    return result('reject', ['CONTROLLER_CORRECTION_PROOF_REQUIRED']);
  }
  return result('reject', ['UNSUPPORTED_AUTO_OPERATION']);
}

export function evaluateRevision({ session, operation, controllerProof = {} }) {
  if (!operationShape(operation)) {
    return result('reject', ['OPERATION_INVALID']);
  }
  if (operation.type === 'EXPAND_AUTHORITY') {
    return result('reauthorize', [operation.type]);
  }
  if (operation.type === 'WEAKEN_CONDITION') {
    return result('successor_required', ['WEAKENING_REQUIRES_SUCCESSOR']);
  }
  if (operation.type === 'CHANGE_GOAL') return result('successor_required', ['GOAL_CHANGE']);
  if (operation.type === 'UNCLASSIFIED') return result('reject', ['UNCLASSIFIED_CHANGE']);
  if (!AUTO_TYPES.has(operation.type)) return result('reject', ['OPERATION_TYPE_UNKNOWN']);
  try {
    return evaluateAuto(session, operation, controllerProof);
  } catch (error) {
    return result('reject', [error.code ?? 'OPERATION_INVALID']);
  }
}
