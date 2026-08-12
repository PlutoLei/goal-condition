# Codex Canonical Controller State Root

## Status

Approved in conversation on 2026-08-12. This specification extends the Codex-only boundary in `2026-08-12-codex-v2-only.md`; it does not change Claude or the shared run contract.

## Problem

GoalSession V2 stores `rollout.json`, sessions, controller evidence, launch intents, and target-root leases under the caller-supplied `--state-root`. A missing rollout file correctly means `disabled`, but every CLI command currently requires the caller to choose that root independently.

That makes an installed release appear enabled only inside the store used by its canary. A later task can accidentally choose a new store, observe `disabled`, and require another rollout ceremony. Reusing an opaque task-specific path is operationally fragile and does not make “Codex V2 is the normal route” mechanically true.

## Root Cause

The controller has a safe state-store abstraction and a safe rollout protocol, but no stable state-root resolver. Deployment identity is therefore implicit in an arbitrary command-line path. The bug is not the fail-closed `disabled` default; it is the absence of one canonical normal path shared by all ordinary Codex GoalSessions.

## Decision

Codex GoalSession V2 will resolve one canonical machine-level controller state root before dispatching any command.

Resolution precedence is:

1. explicit `--state-root PATH`;
2. `GOAL_CONDITION_CODEX_STATE_ROOT`, when set;
3. `$XDG_STATE_HOME/goal-condition/codex-v2`, when `XDG_STATE_HOME` is a normalized absolute path;
4. `<home>/.local/state/goal-condition/codex-v2`.

An explicitly supplied or environment-supplied invalid path fails closed. It never falls through to another path. The existing canonical-path, ancestor-symlink, temporary-directory, permissions, and target-root isolation checks remain authoritative after resolution.

All commands that currently require `--state-root` will accept it as an optional advanced override. Commands without it use the resolver. Commands that do not use controller state remain unchanged.

The normal path is one shared controller store across projects. That gives rollout mode, release-bound canary receipt, event/blob integrity, and target-root lease arbitration one machine-local namespace. An operator who deliberately selects another state root is creating another deployment namespace; its missing rollout state remains `disabled` and must be promoted independently.

Machine-wide deployment also makes session and run identities machine-wide. The controller therefore generates new `session_id` and `run_id` values from 128 bits of randomness and returns them to the caller; new Draft, migration, prepare, and resume inputs cannot select these database keys. Because a response can be lost after durable commit, callers supply a known 128-bit `request_id` for session creation or `nonce` for run creation. The controller transactionally binds that key and an immutable request hash to the generated identifier. An identical retry returns the original identifier; key reuse with different input fails closed. `resume` durably prepares and returns its run ID before a separate `launch` performs runtime work. Existing persisted IDs remain readable.

## Security Boundary

The canonical root is controller-owned state, not an executor workspace. Existing checks must still reject launch whenever that root sits inside any executor target root, resolves through a symlink alias, or lies in a temporary directory.

The environment override is a controller-side deployment input. If it is present but malformed, relative, temporary, or non-canonical, the command fails instead of silently using the home default.

The resolver will not copy, merge, or trust an arbitrary prior store. Rollout receipts are release-bound. After this change creates a new release digest, the canonical store must run a fresh dynamic-revision canary before promotion to `enabled`.

## Alternatives

| Approach | Benefit | Cost | Decision |
|---|---|---|---|
| Reuse the current task-specific path | No code change | Hidden, fragile, and easy to forget | Reject |
| Document a conventional path only | Small documentation change | Still relies on every caller remembering it | Reject |
| Mechanically resolve a canonical root with explicit override | Zero-config normal use, testable routing, preserves fail-closed alternates | One more release and canary; shared store grows over time | Adopt |

## CLI and Documentation Changes

- Add a focused path resolver module under the Codex controller.
- Resolve the state root once after argument parsing and before the handler runs.
- Keep `--state-root` accepted for explicit deployment namespaces.
- Update the Skill and Codex operation protocol to name the canonical default and the meaning of an override.
- Keep `adopt` and `shadow` unavailable; keep `migrate-v1` as the only legacy entry.
- Do not change Claude documentation, adapter behavior, or shared schemas.

## Verification

Tests must prove:

1. precedence is explicit flag, environment, XDG state home, then home fallback;
2. a malformed higher-precedence value fails closed rather than falling through;
3. `mode` and a complete non-live lifecycle work without `--state-root` under a controlled test environment;
4. an explicit state root still selects an isolated namespace;
5. an alternative namespace remains `disabled` until independently promoted;
6. existing symlink, temporary-path, permissions, target-root isolation, release-binding, and rollout tests stay green;
7. the installed Skill documents the zero-config normal path and V2-only routing;
8. the full root and Codex controller suites pass.
9. two unrelated projects using the canonical store receive distinct controller-issued session and run IDs without caller coordination.
10. response-loss retries recover the original session/run ID, while request-key reuse with changed input fails closed.
11. injected failures cannot commit a creation receipt without its session, intent, and lease, or vice versa.

Live acceptance for the new release must run the existing promotion shape in the canonical store:

```text
confirm same Goal+Authority hash
-> canary
-> Attempt 1 Candidate
-> controller-owned ADD_AND_VERIFIER
-> Attempt 1 Rejected
-> Attempt 2 Certified
-> finalize + close
-> enabled(current release digest, certified canary receipt)
```

Final readback must show no leases, no target mutation, no bypasses, two Design revisions, two Conditions, and `GOAL_SESSION_CERTIFIED` as the terminal event.

## Rollback

Rollback changes the canonical store from `enabled` to `canary` or `disabled`; it never selects Codex V1. Reinstalling an older release does not inherit this release's canary because the manifest digest no longer matches.
