# ADR: Claude controller-owned recovery, permissions, and turn budgets

- Date: 2026-08-12
- Status: Accepted

## Context

Claude runs exposed three coupled failures: a max-turns error could arrive in a measured 17-key envelope before a resumable pointer existed; task permissions were ambient and not hash-bound to the confirmed contract; and the adapter treated its default 50 turns as a silent ceiling even when the user explicitly confirmed a larger budget. These are control-plane design defects, not isolated parsing bugs.

## Decision

The controller issues the Claude session UUID and writes a protected `thread.json` pointer before spawn. It recognizes the measured success and `error_max_turns` envelopes as separate closed-world anchors, keeps max-turns as an unfinished resumable candidate, and exposes a fail-open, privacy-safe transcript readback channel. A claimed run cannot launch a second session; it must resume or read back the claimed one.

Run contract v1 gains optional Claude-only `execution_permissions`. The compiler derives Bash prefixes from postflight executables, adds explicitly confirmed Bash/WebFetch/Skill rules, canonicalizes extra directories, and protects controller state plus both project settings files under every target root. The launch gate independently checks the generated authorization surface. The field is authorization, not a generic physical constraint or a read-only sandbox; baseline comparison remains authoritative for mutations.

Claude uses `DEFAULT_MAX_TURNS=50`. An explicitly confirmed positive integer is passed through unchanged up to `MAX_TURNS_CEILING=200`; values above 200 fail before attempt claim and spawn. The controller never silently clamps a confirmed budget.

## Alternatives and trade-offs

Waiting for the executor to return a session ID was simpler, but made the recovery pointer depend on the very success-shaped envelope that max-turns violates. Pre-issuing identity adds pointer lifecycle rules but removes that circular dependency.

Keeping ambient permissions avoided schema work, but made authorization invisible to preview/hash and impossible to reproduce. A fully OS-sandboxed compiler would provide stronger enforcement, but Claude's current adapter has no verified generic sandbox mapping. The selected settings compiler improves determinism while retaining `audit_only` wording for business constraints.

Clamping every run to 50 bounded cost, but contradicted explicit user budgets. Removing all ceiling would honor the contract but create an unbounded single-attempt blast radius. The default-plus-hard-ceiling split preserves both explicit intent and a reviewed adapter maximum.

## Consequences

Existing canonical contracts remain valid because the new field is optional. Any edit that adds permissions changes the contract hash and requires Validate, Preview, and Confirm again. F-B1 has automated generator and fault-injection coverage; a live Claude settings-tamper canary remains a release gate because automated tests do not prove current CLI enforcement behavior.
