# Codex native Goal handoff for Claude maintenance

## Decision and scope

Codex new tasks use native `/goal` as their only sustained execution path. The Codex-specific `goal-condition` skill now defines scope, completion evidence, recovery, and authority; it no longer runs a second controller. `boundary-design` produces a portable brief without requiring a legacy contract.

This change ships under `codex-native/`. The legacy controllers, receipt schemas, and Claude execution implementation remain available and unchanged. Routing notes in shared entry documentation distinguish new Codex work from the legacy material. No Claude configuration or installation is performed by this change.

## Shared semantics to carry forward

- Research and plan requests do not start a goal. Explicit execution of an approved design does not need the same custom approval again.
- Reuse an existing native goal and respect host pause/cancel/status behavior. Do not duplicate execution with a scheduler or child runtime.
- Record only user-supplied resource limits with their units. Do not treat an unspecified budget as paid-resource authorization.
- Bind completion claims to actual evidence. Synthetic/local tests cannot establish real service, GPU, or scientific results.
- Keep project-specific authority, research protocol, publication and review requirements. A runtime migration does not waive them.
- Preserve old artifacts and evidence. A migration note must not forge legacy completion, consume unused admissions, or replay finished external effects.

## Claude-side work left to its maintainer

Verify Claude's current native long-running capabilities before choosing its execution adapter. Do not assume it exposes the same `/goal` API, pause semantics, text limit, or evaluator as Codex. Update Claude-owned skill sources, routing and installation using Claude's own tools and authority. Share goal/evidence semantics rather than runtime state, credentials, or installation directories.

Review the existing condition path's fixed character limit, evaluator assumptions, mandatory clipboard writes, mandatory stopping-budget text, and contract exceptions against current product behavior. Codex's new path does not inherit those assumptions.

## Compatibility and evidence

The new installer backs up old Codex skill entries, installs physical directories, detects drift, and supports rollback. Its legacy inventory is read-only and does not parse raw runtime content. The optional evidence checker assesses a supplied report; it is not an independent verifier and does not control goal state.

Executable checks cover installer failure/rollback/drift, migration metadata, and evidence coverage/scope. Real host behavior scenarios are documented separately and must not be reported as executed merely because these unit tests pass. Private machine migration records and raw native tool receipts stay outside Git.

Native Goal completion must not be called `Certified Complete`. Legacy certification requirements need an explicit project-specific migration decision before their governed work can be moved.
