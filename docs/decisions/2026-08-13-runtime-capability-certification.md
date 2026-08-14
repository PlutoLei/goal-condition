# ADR: Decouple Runtime Certification from Release Integrity

- Status: Accepted
- Date: 2026-08-13
- Related: `2026-08-13-claude-setting-source-isolation.md`

## Context

The immutable goal-condition release currently contains shared code, the Codex controller, and the Claude
adapter under one manifest digest. Codex has an explicit release rollout gate, while Claude native behavior is
represented only by a branch-level live-canary gate. A Claude subscription or session-limit failure can
therefore prevent an honest Claude certification result and be misread as blocking the whole product.

Most verification does not require Claude Code. Contract validation, snapshotting, postflight verification,
unit and integration tests, code review, and the Codex runtime can run independently. Only a real Claude Code
process can certify Claude-specific setting-source, flag-settings, Stop-hook, and result-envelope behavior.

## Decision

Release integrity and runtime certification are separate states.

The installer continues to create one atomic immutable release and one externally trusted whole-release
manifest digest. Manifest schema v2 additionally contains runtime surface digests. Each required file is
classified exactly once as release-only, runtime-shared, Claude-specific, or Codex-specific. A runtime surface
digest is calculated from the canonical manifest entries for runtime-shared files plus that runtime's specific
files. Release-only files remain protected by whole-release integrity without invalidating native certification.

The installer separates staging from activation. Staging creates and verifies an immutable release without
switching runtime links. Production certification runs against that exact staged release; activation later
switches links to the same physical root and exact manifest digest. A development receipt may certify a clean
source checkout, but it binds the checkout realpath and commit and cannot be transferred to a staged or installed
release.

Claude gains an external machine-level Candidate/Certified capability state. An ordinary Claude launch is
allowed only when a controller-owned certification receipt exactly matches the installed Claude runtime
surface, current Claude CLI version, OS, architecture, non-secret authentication mode, and operator-managed
opaque authentication-context ID. A missing or stale receipt blocks only `runtime="claude"`; it does not block
Codex or offline shared functionality.

Codex rollout state is split the same way: the whole-release manifest digest remains its integrity trust root,
while its certified canary receipt binds the Codex runtime surface digest. Claude-only and release-only changes
therefore do not invalidate Codex certification.

Candidate mode has one narrow execution path: a controller-owned certification command using a fixed canary
profile. It still performs canonical compilation, validation, full preview, current-hash confirmation,
preflight, the normal Claude prepare/attempt path, independent postflight, and baseline comparison. The receipt
is published only when all five setting-source isolation conditions pass. Provider errors, quota limits, and
network failures leave the state Candidate and are reported as external blockers rather than failed canaries.

A dedicated low-volume Anthropic canary identity is the recommended operational credential. Credentials and
account identifiers are not stored in manifests, receipts, or logs. Personal Claude OAuth remains an explicit
manual fallback, not the release infrastructure.

## Consequences

- Claude quota failures no longer block Codex runtime delivery or shared offline work.
- Codex-only changes do not invalidate Claude certification.
- Claude-only changes do not invalidate Codex certification.
- Shared or Claude-specific code changes, CLI changes, platform changes, or auth-mode changes require a new
  Claude live canary.
- The installed release remains atomic; packaging, rollback, and link switching do not multiply.
- The manifest schema, launch-module boundaries, capability state, and certification controller require new
  implementation and tests.
- A release can be integrity-verified while Claude remains Candidate. Reports must keep implementation, tests,
  review, certification, push, merge, installation, release, and production effect separate.

## Rejected Alternatives

- Waiting for a personal subscription reset preserves the same organizational dependency.
- Binding Claude certification to the whole release digest still invalidates it after Codex-only changes.
- Treating fake-executor tests or Codex runs as Claude evidence cannot verify vendor-native behavior.
- Splitting shared, Claude, and Codex code into separate installation transactions adds rollback and compatibility
  complexity without being necessary to separate certification.
