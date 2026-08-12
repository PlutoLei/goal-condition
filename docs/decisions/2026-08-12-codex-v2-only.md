# ADR: Codex Uses GoalSession v2 Exclusively

- Status: Accepted
- Date: 2026-08-12
- Supersedes: the Codex legacy-live and shadow rollout portions of `2026-08-11-codex-goal-session-v2.md`

## Context

GoalSession v2 is already the installed default for new Codex work, but legacy Codex execution remains reachable through router wording, rollout modes, shadow support, and the “existing tasks continue legacy” rule. At the same time, V2 internally projects an immutable launcher payload validated by the shared v1 schema. Treating both as the same architectural layer either preserves an unwanted fallback or forces a risky launcher rewrite.

## Decision

Codex exposes and executes only GoalSession v2. Controller absence or a closed release gate fails closed. Old Codex contracts enter only through a one-way `migrate-v1` import that creates an unconfirmed V2 Draft.

The internal launcher payload remains but is named `AttemptManifest`. Its format version is not a runtime-routing signal. Claude and the shared run-contract schema are unchanged.

V2 rollout modes are `disabled`, `canary`, and `enabled`. Legacy rollout files are converted once with `shadow→disabled`, `opt-in→canary`, and `default|legacy-freeze→enabled`. No state falls back to V1.

## Consequences

- Codex routing and execution have a single lifecycle and authority model.
- Release safety retains canary promotion without retaining a legacy runtime.
- Existing Codex v1 tasks require explicit migration and fresh V2 authorization.
- The launcher, snapshot, verifier, and shared Claude schema remain stable.
- Historical references may still contain “v1” as history; production docs and callable Codex surfaces do not expose a legacy mode.

## Rejected Alternatives

- A Skill-only default change leaves executable legacy paths and ambiguous terminology.
- A native V2 launcher-manifest rewrite expands the trusted codebase without a user-visible safety benefit.
