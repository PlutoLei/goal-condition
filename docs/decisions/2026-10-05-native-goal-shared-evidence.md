# ADR: Native `/goal` on Both Runtimes, Shared Evidence Semantics

- Status: Accepted
- Date: 2026-10-05
- Supersedes: the Codex routing portion of `2026-08-12-codex-v2-only.md` for new work; the "Claude-side work left to its maintainer" section of `docs/handoffs/2026-09-09-codex-native-goal.md`

## Context

The user's goal is to run long tasks through the native `/goal` of both Claude Code and Codex. An audit on 2026-10-05 found the two installed skills had diverged:

- The Codex skill came from an unmerged branch (`codex/native-goal-workflow`) whose source lived in a worktree of a clone scheduled for retirement.
- The Claude skill on `main` described the Claude evaluator, the 4000-character limit and the in-text stop clause as if both runtimes shared them.
- `main` still described GoalSession v2 as the Codex entry point.

The two native mechanisms really differ (Claude Code 2.1.289 docs and binary; Codex 0.160.0 tool schemas):

| | Claude Code | Codex |
|---|---|---|
| Start | User types `/goal` (≤4000 chars), or the model calls `ProposeGoal` (≤500 chars, one-key approval, interactive sessions only) | Model calls `create_goal` on explicit request, or user types `/goal` |
| Completion | Separate small evaluator model reads only the transcript | Executing model self-audits, then calls `update_goal` |
| Budget | None native; written into the condition | Native `token_budget` |
| Controls | `/goal`, `/goal clear` | `/goal edit/pause/resume/clear`, `blocked` after three repeated turns |

A design discussion between Claude and Codex agreed on accepting the mechanism differences while unifying the evidence standard.

## Decision

1. Both runtimes use native `/goal` for long tasks. Neither skill runs a second controller or judges completion itself.
2. `shared/goal-semantics.md` is the single source for goal, authority, budget and evidence semantics. Each runtime skill ships a byte-identical copy in `references/goal-semantics.md`; a test enforces equality and keeps runtime launch facts out of the shared file.
3. Each runtime skill keeps only its own launch, length, budget, status and stop facts. The Claude skill now prefers `ProposeGoal` for conditions within 500 characters and falls back to the verified clipboard path.
4. The evidence standard is the same on both sides: fresh observations bound to explicit objects, missing evidence counts as failure, goal achievement and budget exhaustion are reported separately. Neither native judge independently verifies files, so high-risk work still needs verification outside the executor.
5. The Claude run contract becomes a maintenance-mode controlled channel, entered only on explicit user choice. Codex GoalSession v2 serves only existing sessions, recovery, and `migrate-v1`.
6. The layering is logical, not physical. `goal-condition-template/` and its release core stay in place.

## Consequences

- One shared rule set, two thin runtime adapters; drift between the copies fails `npm test`.
- Adding `references/goal-semantics.md` to the release core edits `scripts/lib/runtime-surfaces.mjs`, a `runtime_shared` file, so both runtime surface digests change. `activate` checks release integrity only and does not require certification, and native `/goal` needs none. The controlled Claude launch stays Candidate until the new release is certified, and an existing Codex GoalSession v2 rollout gate drops to `canary`.
- Staging a commit older than this change with the current installer fails `CORE_SOURCE_MISSING`, as with earlier core additions.
- The Codex native distribution now lives on `main`, so retiring the old clone no longer loses its source.

## Rejected Alternatives

- **Physical restructure into `shared/`, `runtimes/`, `legacy/`.** The installer, release manifests, runtime-surface digests and certification receipts bind the `goal-condition-template/` paths. Moving them would require coordinated changes to the installer, the manifest and surface tables, and the certification path checks, with no change in runtime behavior.
- **Symmetric controllers.** Restoring GoalSession v2 for Codex, or adding a launcher for Claude, contradicts the native-first priority and duplicates what the hosts already provide.
- **Pure native on both sides, deleting the Claude run contract.** The contract still provides hash confirmation, baseline snapshots and independent postflight for audited work, and it has a current certification. Keep it, but freeze its scope.
