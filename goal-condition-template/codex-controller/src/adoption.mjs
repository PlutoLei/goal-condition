import { validateContract } from '../../scripts/lib/contract.mjs';
import { compileDraft } from './compiler.mjs';

const HASH = /^[0-9a-f]{64}$/;

function adoptionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function slug(value, fallback) {
  const result = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return /^[a-z0-9]/.test(result) ? result : fallback;
}

function uniqueId(value, fallback, used) {
  const base = slug(value, fallback);
  let candidate = base;
  let suffix = 1;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

function verifierFor(contract, index, used) {
  const source = contract.postflight[index] ?? contract.postflight[0];
  if (source === undefined) throw adoptionError('LEGACY_VERIFIER_REQUIRED', 'legacy contract has no command verifier');
  return {
    id: uniqueId(source.id, `legacy-verifier-${index + 1}`, used),
    type: 'command',
    cwd: source.cwd,
    argv: structuredClone(source.argv),
    capture: source.capture,
  };
}

export function adoptLegacyContract({ contract, sessionId, currentStateDigest, originalBaseline }) {
  const diagnostics = validateContract(contract);
  if (diagnostics.length > 0 || contract.runtime !== 'codex') {
    throw adoptionError('LEGACY_CONTRACT_INVALID', 'adoption requires a valid Codex v1 contract');
  }
  if (typeof currentStateDigest !== 'string' || !HASH.test(currentStateDigest)) {
    throw adoptionError('LEGACY_BASELINE_INVALID', 'currentStateDigest must be lowercase SHA-256');
  }
  const used = new Set();
  const deliverableId = 'legacy-deliverable';
  const criteria = [
    ...contract.success_criteria.map((item) => ({ source: item, kind: 'success', rule: item.command })),
    ...contract.judgment_criteria.map((item) => ({ source: item, kind: 'judgment', rule: item.rule })),
  ];
  const conditions = criteria.map((entry, index) => {
    const id = uniqueId(entry.source.id, `legacy-condition-${index + 1}`, used);
    return {
      id,
      kind: entry.kind,
      rule: entry.rule,
      deliverable_ref: deliverableId,
      verifier: verifierFor(contract, index, used),
      projection: {
        criterion_id: uniqueId(`legacy-${entry.source.id}`, `legacy-criterion-${index + 1}`, used),
        command: entry.source.command ?? entry.source.rule,
        expected: entry.source.expected ?? entry.source.why,
      },
      depends_on: [],
      introduced_by: 'legacy-adoption',
      strengthens: [],
    };
  });
  if (!conditions.some((condition) => condition.kind === 'success')) {
    throw adoptionError('LEGACY_SUCCESS_CONDITION_REQUIRED', 'legacy contract has no success criterion');
  }
  const writes = contract.allowed_mutations.files.length > 0 || contract.allowed_mutations.git.length > 0;
  const external = structuredClone(contract.allowed_mutations.external);
  const budget = contract.budget?.user_provided === true
    ? contract.budget.max_cost_usd ?? null
    : null;
  const draft = {
    session_id: sessionId,
    goal: {
      statement: contract.objective,
      deliverables: [{ id: deliverableId, description: contract.objective }],
    },
    non_goals: contract.constraints.map((constraint) => constraint.rule),
    root_baseline: {
      kind: originalBaseline === null ? 'adopted-current-state' : 'legacy-original',
      digest: originalBaseline?.digest ?? currentStateDigest,
    },
    authority: {
      target_roots: structuredClone(contract.target_roots),
      actions: writes ? ['read', 'write', 'execute'] : ['read', 'execute'],
      external_effects: external,
      secret_refs: [],
      destructive: false,
      maximum_risk: 'low',
      maximum_budget: budget,
      // Legacy prose constraints have no trustworthy one-to-one mapping to v2 mechanical capabilities.
      // Preserve them for confirmation as non-goals; the adopter must explicitly choose v2 capabilities.
      hard_prohibitions: [],
    },
    initial_design: {
      active_boundary: {
        target_roots: structuredClone(contract.target_roots),
        actions: writes ? ['read', 'write', 'execute'] : ['read', 'execute'],
        external_effects: external,
        secret_refs: [],
        destructive: false,
        risk: 'low',
        budget,
      },
      conditions,
      context_dependencies: contract.context_sources.map((source) => ({
        id: slug(source.id, 'legacy-context'),
        path: source.path,
        sha256: source.sha256,
      })),
      projection_version: 'v1-adoption',
      reason: 'explicit legacy v1 adoption',
    },
  };
  const compiled = compileDraft(draft);
  if (compiled.session === null) {
    throw adoptionError('LEGACY_ADOPTION_COMPILE_FAILED', compiled.gaps.map((item) => item.code).join(','));
  }
  return {
    session: compiled.session,
    provenance: {
      provenance_version: 1,
      baseline_provenance: originalBaseline === null ? 'adopted_at_current_state' : 'legacy_original',
      legacy_confirmation: 'unverified',
      certifies_pre_adoption_state: false,
    },
  };
}
