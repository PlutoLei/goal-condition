import { validateContract } from '../../scripts/lib/contract.mjs';
import { compileDraft } from './compiler.mjs';

const HASH = /^[0-9a-f]{64}$/;

function migrationError(code, message) {
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
  if (source === undefined) throw migrationError('V1_MIGRATION_VERIFIER_REQUIRED', 'v1 input has no command verifier');
  return {
    id: uniqueId(source.id, `v1-verifier-${index + 1}`, used),
    type: 'command',
    cwd: source.cwd,
    argv: structuredClone(source.argv),
    capture: source.capture,
  };
}

export function migrateV1Contract({ contract, sessionId, currentStateDigest, originalBaseline }) {
  const diagnostics = validateContract(contract);
  if (diagnostics.length > 0 || contract.runtime !== 'codex') {
    throw migrationError('V1_MIGRATION_CONTRACT_INVALID', 'migration requires a valid Codex v1 input contract');
  }
  if (typeof currentStateDigest !== 'string' || !HASH.test(currentStateDigest)) {
    throw migrationError('V1_MIGRATION_BASELINE_INVALID', 'currentStateDigest must be lowercase SHA-256');
  }
  const used = new Set();
  const deliverableId = 'migrated-deliverable';
  const criteria = [
    ...contract.success_criteria.map((item) => ({ source: item, kind: 'success', rule: item.command })),
    ...contract.judgment_criteria.map((item) => ({ source: item, kind: 'judgment', rule: item.rule })),
  ];
  const conditions = criteria.map((entry, index) => {
    const id = uniqueId(entry.source.id, `v1-condition-${index + 1}`, used);
    return {
      id,
      kind: entry.kind,
      rule: entry.rule,
      deliverable_ref: deliverableId,
      verifier: verifierFor(contract, index, used),
      projection: {
        criterion_id: uniqueId(`v1-${entry.source.id}`, `v1-criterion-${index + 1}`, used),
        command: entry.source.command ?? entry.source.rule,
        expected: entry.source.expected ?? entry.source.why,
      },
      depends_on: [],
      introduced_by: 'v1-migration',
      strengthens: [],
    };
  });
  if (!conditions.some((condition) => condition.kind === 'success')) {
    throw migrationError('V1_MIGRATION_SUCCESS_CONDITION_REQUIRED', 'v1 input has no success criterion');
  }
  const writes = contract.allowed_mutations.files.length > 0 || contract.allowed_mutations.git.length > 0;
  const external = structuredClone(contract.allowed_mutations.external);
  const budget = contract.budget?.user_provided === true
    ? contract.budget.max_cost_usd ?? null
    : null;
  const draft = {
    goal: {
      statement: contract.objective,
      deliverables: [{ id: deliverableId, description: contract.objective }],
    },
    non_goals: contract.constraints.map((constraint) => constraint.rule),
    root_baseline: {
      kind: originalBaseline === null ? 'migrated-current-state' : 'v1-original',
      digest: currentStateDigest,
    },
    authority: {
      target_roots: structuredClone(contract.target_roots),
      actions: writes ? ['read', 'write', 'execute'] : ['read', 'execute'],
      external_effects: external,
      secret_refs: [],
      destructive: false,
      maximum_risk: 'low',
      maximum_budget: budget,
      // V1 prose has no trustworthy one-to-one mapping to V2 mechanical capabilities.
      // Preserve it for the fresh V2 confirmation instead of manufacturing enforcement.
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
        id: slug(source.id, 'v1-context'),
        path: source.path,
        sha256: source.sha256,
      })),
      projection_version: 'v1-migration',
      reason: 'explicit v1 to GoalSession v2 migration',
    },
  };
  const compiled = compileDraft(draft, { sessionId });
  if (compiled.session === null) {
    throw migrationError('V1_MIGRATION_COMPILE_FAILED', compiled.gaps.map((item) => item.code).join(','));
  }
  return {
    session: compiled.session,
    provenance: {
      provenance_version: 1,
      baseline_provenance: originalBaseline === null ? 'migrated_at_current_state' : 'v1_original',
      legacy_confirmation: 'unverified',
      certifies_pre_migration_state: false,
    },
  };
}
