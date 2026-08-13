# ADR: Isolate Claude setting sources instead of scanning project settings

- Date: 2026-08-13
- Status: Accepted
- Supersedes: the project-settings deny/scan portion of `2026-08-12-claude-controller-recovery-permissions-budget.md`

## Context

Claude merges `permissions` from ambient user, project, and local settings with the Controller-generated
`--settings` file. A first fix scanned `.claude/settings*.json` before launch and rejected files containing
permissions. Re-review found the scan could never close the interval between inspection and Claude opening
the files; adding bounded reads, git-root discovery, and a second scan created more parser, platform, and
TOCTOU surface without making the effective permission set deterministic.

The same repair wave also showed that target-root Edit deny rules forced otherwise valid filesystem paths
through Claude's unescaped `Tool(specifier)` DSL. This coupled path validity to an ambient configuration
source that the Controller did not need.

## Decision

Every Claude launch and resume passes `--setting-sources ""` together with the Controller-owned
`--settings <file>`. Claude's source model always retains flag settings and policy settings while excluding
user, project, and local settings. Prepare probes `claude --help` for `--setting-sources`; launch fails closed
when the capability is absent or the state directory predates the probe.

The project-settings scanner and target-local settings deny rules are removed. Target roots no longer enter
the permission-specifier DSL; only actual Bash/WebFetch/Skill rules plus the Controller state/hook deny paths
must be representable. Policy settings remain an external administrative authority and are not disabled.

All Claude-accessible roots, including target roots and `additional_read_roots`, must be disjoint from the
Controller state directory. The overlap test is component-safe and handles `/`. The versioned session pointer
records canonical roots and launch-time device/inode identities as decimal strings; resume rejects both path
drift and same-path identity replacement without JavaScript number precision loss.

A per-state exclusive Claude attempt lease starts before attempt-specific `settings.json` publication and
serializes validation, reservation, pointer publication, executor lifetime, and result persistence. An attempt
is spent only after the executor is invoked. A launch-time failure after reservation but before dispatch
releases the Controller-owned pointer and highest attempt slot; the lease prevents either a concurrent settings
replacement or a higher attempt from corrupting the active authorization surface or budget.

Controller claims are fully written and fsynced through a unique same-directory private inode, then published
with an atomic no-replace hard link. The private name is removed only after publication. Failure cleanup never
unlinks the public pathname, so it cannot delete a foreign claim that won or replaced that name.

## Alternatives and trade-offs

The minimal alternative was to bound file reads, use native git-root resolution, scan again immediately
before spawn, and improve diagnostics. It preserves ambient settings, but the final scan-to-open race remains
and every Claude discovery-rule change can silently invalidate the scanner. It is retained only as a rejected
emergency fallback.

Removing `execution_permissions` entirely would have the smallest permission compiler, but would also remove
explicit contract-bound Bash/WebFetch/Skill authorization and extra-directory reachability. Source isolation
keeps those useful projections while deleting the ambient merge surface that caused repeated repair waves.

The cost is intentional: user/project/local Claude configuration, including project hooks and local model
preferences, does not participate in controlled runs. Policy settings still apply. This is a reproducibility
boundary, not an OS sandbox; baseline comparison remains authoritative for mutations.

## Consequences

Existing prepared Claude state with no claimed session must be prepared again because the capability probe and
pointer shape changed. A legacy six-field in-flight pointer cannot be migrated by `prepare`: read back and
reconcile it with the original adapter, then start a fresh controller state. An abandoned
`claude-attempt.lock` stays fail closed: PID liveness plus pathname deletion is not an atomic ownership proof,
so the Controller requires explicit reconciliation instead of auto-deleting a possibly live run.
The old F-B1 target-settings tamper canary is no longer the release oracle for ambient union. Release evidence
must instead show that source isolation is present, Controller flag settings still load, ambient project
permissions do not load, and state/baseline protections remain intact.
