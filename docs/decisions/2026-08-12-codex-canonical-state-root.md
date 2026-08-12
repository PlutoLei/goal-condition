# ADR: Codex Uses One Canonical Controller State Root

- Status: Accepted
- Date: 2026-08-12
- Extends: `2026-08-12-codex-v2-only.md`

## Context

GoalSession v2 correctly stores rollout mode, release-bound canary receipts, sessions, Evidence, launch intents, and target-root leases in a controller-owned state root. However, every command required the caller to select that root. Enabling one task-specific store therefore did not enable the next task using another store, so V2-only routing was operationally fragile even though each store failed closed correctly.

The root cause was a missing deployment-identity resolver, not the `disabled` default or the rollout state machine.

## Decision

Every stateful Codex controller command resolves one machine-level store with this strict precedence:

1. explicit `--state-root`;
2. `GOAL_CONDITION_CODEX_STATE_ROOT`;
3. absolute, normalized `$XDG_STATE_HOME/goal-condition/codex-v2`;
4. `<home>/.local/state/goal-condition/codex-v2`.

A present but invalid higher-precedence value fails closed and never falls through. The existing physical-path, ancestor-symlink, temporary-directory, permissions, and target-root isolation checks remain authoritative after resolution.

The default is a shared machine-local deployment namespace. An explicit override creates a separate namespace with its own rollout gate, release-bound canary receipt, sessions, and leases. It does not inherit `enabled` from the default store.

Because the deployment namespace is machine-wide, identifiers with machine-wide storage keys are controller-owned. New `session_id` and `run_id` values use 128 bits of controller randomness and are returned by `init`/`migrate-v1` and `prepare`/`resume`. Callers propagate these values but cannot select them. Existing stored identifiers remain readable for compatibility.

Claude and the shared run-contract schema are unchanged. A release containing this change requires a fresh dynamic-revision live canary before the canonical store can become `enabled`.

## Consequences

- Ordinary Codex GoalSessions require no state-root argument and share one mechanically enforced rollout decision.
- Target-root leases arbitrate across projects in the same machine-level control plane.
- Operators retain isolated namespaces for testing or incident recovery, but each must be promoted independently.
- Malformed environment configuration is visible immediately instead of silently selecting another store.
- The canonical store accumulates machine-level session history and must remain controller-owned.
- Session and run creation becomes response-driven: later commands use the controller-issued identifiers from the preceding response.

## Rejected Alternatives

- Reusing the prior task-specific path keeps a hidden operational dependency.
- Documenting a conventional path without resolving it mechanically still relies on every caller remembering it.
- Copying or merging rollout state between roots would weaken the release-bound trust model.
