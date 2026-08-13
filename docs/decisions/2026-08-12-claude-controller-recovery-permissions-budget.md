# ADR: Claude controller-owned recovery, permissions, and turn budgets

- Date: 2026-08-12
- Status: Accepted

> 2026-08-13 amendment: the project-settings scan/deny portion below is superseded by
> `2026-08-13-claude-setting-source-isolation.md`. Contract-bound permissions remain; ambient user/project/local
> settings are now excluded with `--setting-sources ""` instead of inspected.

## Context

Claude runs exposed three coupled failures: a max-turns error could arrive in a measured 17-key envelope before a resumable pointer existed; task permissions were ambient and not hash-bound to the confirmed contract; and the adapter treated its default 50 turns as a silent ceiling even when the user explicitly confirmed a larger budget. These are control-plane design defects, not isolated parsing bugs.

## Decision

The controller issues the Claude session UUID and writes a protected `thread.json` pointer with an exclusive create before spawn. Pointer reads are no-follow, regular-file, single-link, and closed-world; any existing invalid pointer fails closed instead of reopening launch. It recognizes the measured success and `error_max_turns` envelopes as separate closed-world key-and-value anchors, keeps max-turns as an unfinished resumable candidate, and exposes a fail-open transcript readback whose executor-controlled values are mapped to fixed privacy-safe enums. A claimed run cannot launch a second session; it must resume or read back the claimed one.

Run contract v1 gains optional Claude-only `execution_permissions`. One permission-specifier representability rule is shared by validation and compilation and covers every interpolated allow/deny value; the launch gate independently rechecks source values so direct-call bypasses fail closed. The compiler adds explicitly confirmed Bash/WebFetch/Skill rules, canonicalizes extra directories, and protects Controller state. Postflight executables are deliberately not projected into Bash rules because execFile argv semantics cannot be safely encoded in Claude's shell-prefix DSL. Launch cwd uses the canonical first root, and every authorized root's device/inode is rebound immediately before dispatch. The field is authorization, not a generic physical constraint or a read-only sandbox; baseline comparison remains authoritative for mutations.

Claude uses `DEFAULT_MAX_TURNS=50`. An explicitly confirmed positive integer is passed through unchanged up to `MAX_TURNS_CEILING=200`; values above 200 fail before attempt claim and spawn. The controller never silently clamps a confirmed budget.

## Alternatives and trade-offs

Waiting for the executor to return a session ID was simpler, but made the recovery pointer depend on the very success-shaped envelope that max-turns violates. Pre-issuing identity adds pointer lifecycle rules but removes that circular dependency.

Keeping ambient permissions avoided schema work, but made authorization invisible to preview/hash and impossible to reproduce. A fully OS-sandboxed compiler would provide stronger enforcement, but Claude's current adapter has no verified generic sandbox mapping. The selected settings compiler improves determinism while retaining `audit_only` wording for business constraints.

Clamping every run to 50 bounded cost, but contradicted explicit user budgets. Removing all ceiling would honor the contract but create an unbounded single-attempt blast radius. The default-plus-hard-ceiling split preserves both explicit intent and a reviewed adapter maximum.

## Consequences

Existing canonical contracts remain valid because the new field is optional. Any edit that adds permissions changes the contract hash and requires Validate, Preview, and Confirm again. The target-settings deny and scanner described by the original F-B1 gate are superseded by the 2026-08-13 setting-source isolation ADR; current release evidence must exercise the replacement boundary against the live CLI.
