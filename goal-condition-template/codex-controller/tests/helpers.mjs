export const SHA_A = 'a'.repeat(64);

export function validDraft() {
  return {
    session_id: 'session-0001',
    goal: {
      statement: 'Ship the verified report parser change.',
      deliverables: [
        { id: 'delivery-main', description: 'A tested report parser implementation.' },
      ],
    },
    non_goals: ['Do not deploy to production.'],
    root_baseline: {
      kind: 'git-tree',
      digest: SHA_A,
    },
    authority: {
      target_roots: ['/work/project'],
      actions: ['read', 'write', 'execute'],
      external_effects: [],
      secret_refs: [],
      destructive: false,
      maximum_risk: 'low',
      maximum_budget: null,
      hard_prohibitions: ['network-deny'],
    },
    initial_design: {
      active_boundary: {
        target_roots: ['/work/project'],
        actions: ['read', 'write', 'execute'],
        external_effects: [],
        secret_refs: [],
        destructive: false,
        risk: 'low',
        budget: null,
      },
      conditions: [
        {
          id: 'condition-tests',
          kind: 'success',
          rule: 'All declared tests pass.',
          deliverable_ref: 'delivery-main',
          verifier: {
            id: 'verify-tests',
            type: 'command',
            cwd: '/work/project',
            argv: ['npm', 'test'],
            capture: 'text',
          },
          projection: {
            criterion_id: 'success-tests',
            command: 'Run the declared test suite.',
            expected: 'Exit code 0.',
          },
          depends_on: [],
          introduced_by: 'initial',
          strengthens: [],
        },
      ],
      context_dependencies: [],
      projection_version: 'v1',
      reason: 'initial compilation',
    },
  };
}
