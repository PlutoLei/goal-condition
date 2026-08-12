import { canonicalJson, validateContract } from '../../scripts/lib/contract.mjs';
import { exactFields } from './values.mjs';

const REPLAY_FIELDS = Object.freeze([
  'legacy_contract',
  'current_contract',
  'candidate',
  'postflight',
  'observations',
  'legacy_state_path',
]);
const OBSERVATION_FIELDS = Object.freeze(['typed_operation', 'condition_change']);
const AUTO_OPERATIONS = new Set([
  'ADD_CONDITION',
  'ADD_AND_VERIFIER',
  'TIGHTEN_TYPED_THRESHOLD',
  'NARROW_ACTIVE_BOUNDARY',
  'EXPAND_WITHIN_AUTHORITY',
  'REFRESH_CONTEXT',
  'REPLACE_EQUIVALENT_VERIFIER',
  'CONTROLLER_CORRECTION',
]);

function shadowError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function proposal(type, decision, reasonCodes, payload = {}) {
  return {
    operation: { version: 1, type, payload },
    decision,
    reason_codes: reasonCodes,
    mode: 'shadow',
    live_execution: false,
  };
}

function rootInside(candidate, roots) {
  return roots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
}

function changedContexts(legacy, current) {
  const legacyById = new Map(legacy.context_sources.map((item) => [item.id, item]));
  return current.context_sources.filter((item) => {
    const prior = legacyById.get(item.id);
    return prior !== undefined && prior.path === item.path && prior.sha256 !== item.sha256;
  });
}

export function classifyShadowReplay(input) {
  exactFields(input, REPLAY_FIELDS, 'shadow_replay');
  exactFields(input.observations, OBSERVATION_FIELDS, 'shadow_replay.observations');
  for (const [name, contract] of [
    ['legacy_contract', input.legacy_contract],
    ['current_contract', input.current_contract],
  ]) {
    const diagnostics = validateContract(contract);
    if (diagnostics.length > 0) {
      throw shadowError('SHADOW_CONTRACT_INVALID', `${name} is not a valid v1 contract`);
    }
  }
  const legacy = input.legacy_contract;
  const current = input.current_contract;
  if (legacy.objective !== current.objective) {
    return proposal('CHANGE_GOAL', 'successor_required', ['OBJECTIVE_SEMANTICS_CHANGED']);
  }
  const expandedRoots = current.target_roots.filter((root) => !rootInside(root, legacy.target_roots));
  if (expandedRoots.length > 0) {
    return proposal('EXPAND_AUTHORITY', 'reauthorize', ['TARGET_ROOT_EXPANSION'], {
      target_roots: expandedRoots,
    });
  }
  if (input.observations.condition_change === 'weaker') {
    return proposal('WEAKEN_CONDITION', 'reauthorize', ['CONDITION_WEAKENING_OBSERVED']);
  }
  const typed = input.observations.typed_operation;
  if (typed !== undefined) {
    exactFields(typed, ['type'], 'shadow_replay.observations.typed_operation');
    if (AUTO_OPERATIONS.has(typed.type)) {
      return proposal(typed.type, 'auto_apply', ['TYPED_DESIGN_DELTA']);
    }
    if (typed.type === 'EXPAND_AUTHORITY' || typed.type === 'WEAKEN_CONDITION') {
      return proposal(typed.type, 'reauthorize', [typed.type]);
    }
    if (typed.type === 'CHANGE_GOAL') {
      return proposal('CHANGE_GOAL', 'successor_required', ['GOAL_CHANGE']);
    }
  }
  const contexts = changedContexts(legacy, current);
  if (contexts.length === 1
    && canonicalJson({ ...legacy, context_sources: current.context_sources }) === canonicalJson(current)) {
    return proposal('REFRESH_CONTEXT', 'auto_apply', ['CONTEXT_HASH_CHANGED'], {
      dependency_id: contexts[0].id,
      prior_hash: legacy.context_sources.find((item) => item.id === contexts[0].id).sha256,
      next_hash: contexts[0].sha256,
    });
  }
  return proposal('UNCLASSIFIED', 'reject', ['SHADOW_DIFF_UNCLASSIFIED']);
}
