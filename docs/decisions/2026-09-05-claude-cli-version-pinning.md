# ADR: Pin the Claude executor binary to a certified version instead of resolving `claude` from PATH

- Status: Proposed
- Date: 2026-09-05
- Related: `2026-08-13-runtime-capability-certification.md`

## Context

The Claude capability receipt binds the exact CLI version (`environment.cli_version`), and an ordinary
launch is allowed only when the receipt matches the CLI that will actually run. The launcher, however,
resolves that CLI by name: `execFile('claude', ...)` in `runners/claude.mjs` and `launch.mjs`, and
`argv[0] = 'claude'` in `adapters/claude.mjs`. Which binary answers to that name is decided by the
Claude Code native installer, which auto-updates and keeps every downloaded version side by side under
`~/.local/share/claude/versions/` (2.1.258 through 2.1.261 are present on the reference machine today).

Two real data points bracket the cost of leaving the choice to the installer:

| Transition | What happened | Cost |
|---|---|---|
| 2.1.223 to 2.1.260 (2026-09-04) | The success envelope grew from 21 to 24 keys. Every real run fail-closed on `terminal_report` even though the executor reported `subtype:success`. | Three re-anchoring PRs (#8, #9, #10) before any Claude launch could pass again. |
| 2.1.260 to 2.1.261 (2026-09-05) | The installer upgraded between two working days. The existing receipt no longer matched, so every launch would have stopped at `CLAUDE_CAPABILITY_UNCERTIFIED`. Re-certification against the same release passed all five conditions with no envelope drift. | About one minute of operator time, run `8db0a5d5-698f-4a0f-8091-033246554d66`, contract hash `814eed44…bbcf5`. |

The fail-closed direction is correct in both cases. What is uncontrolled is the timing: an upgrade the
operator did not schedule invalidates the receipt at an arbitrary moment, and whether the next step is a
one-minute re-certification or a multi-PR re-anchor is discovered only when a run is already wanted.

## Options

1. **Status quo.** Resolve `claude` from PATH; re-certify whenever `claude --version` stops matching the
   receipt. Zero launcher change. Every installer auto-update is a surprise outage for controlled runs,
   and drift is discovered under pressure.
2. **Pin the executor binary to the certified version.** The receipt additionally binds the realpath and
   SHA-256 of the binary that passed the canary. Launch, resume, and the certification commands invoke that
   exact path as an absolute `argv[0]`, re-read its `--version`, and compare both against the receipt at
   spawn time. A new CLI version enters the execution surface only through an explicit
   `certify-claude-prepare` / `certify-claude-run` against the new path.
3. **Pin with automatic fallback to PATH** when the pinned binary is missing. Rejected: a silent fallback
   is a second source of truth for what is being executed, the same objection this project already raised
   against a parallel `--disallowedTools` permission table in `adapters/claude.md`.

## Decision (proposed)

Adopt option 2 in its minimal shape.

- The certification receipt gains `environment.cli_binary = { realpath, sha256 }`, captured from the
  binary that actually ran the canary. Schema version of the receipt increments; older receipts degrade to
  Candidate exactly as any other field drift does today.
- `prepareClaude`, the capability gate, and the compiled launch/resume argv use the receipt's realpath, not
  the name `claude`. Before every spawn the controller lstat/hashes the file and runs `<path> --version`;
  any mismatch against the receipt is `CLAUDE_CAPABILITY_UNCERTIFIED`, never a fallback.
- Upgrading is an operator action: certify the new binary path, then let the new receipt switch the pin.
  Nothing in the controller watches the installer or picks "latest".
- `CLAUDE_VERSION_FLOOR` stays the tested minimum and `CLAUDE_RESULT_KEYS` stays the exact envelope anchor.
  Pinning changes *when* drift is met (at a deliberate upgrade, with a re-anchor PR merged before the pin
  moves), not *whether* the anchor is exact.

## Consequences

- Controlled runs become independent of the installer's auto-update timing. The 2.1.261 upgrade would have
  been invisible until the operator chose to certify it.
- Security and bug fixes in the CLI reach the executor only when the operator upgrades. A stale pin must be
  a visible operator concern, for example a warning in `readback` when the pinned version is older than the
  PATH version, without that warning changing any gate.
- The versioned directory is owned by the Claude installer and may be pruned on update. The pin therefore
  binds a content hash, and a missing or rewritten binary fails closed. Copying the certified binary into a
  controller-owned location is a possible hardening, deferred until the pruning behaviour is observed.
- This ADR ships no code. The launcher change, receipt schema bump, and tests are a separate PR once the
  decision is accepted.
