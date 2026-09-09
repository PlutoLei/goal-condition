# Validation record — 2026-09-09

Environment: macOS, Node.js 25.9.0. This records engineering checks for the Codex-native distribution, not a runtime certification.

| Check | Observed result |
|---|---|
| `npm run test:native` | 31 passed, 0 failed, 0 skipped |
| `npm test` | 442 passed, 0 failed, 0 skipped |
| Skill creator frontmatter validation | Both native skills valid |
| Real Codex installation | Two physical skill entries installed; status reports no drift; installed bytes match source |
| Existing-state preservation | Six legacy database byte hashes unchanged after installation |
| Native Goal smoke | Current authorized migration used native goal creation, readback and reuse; no second controller launched |

The first full legacy run exposed a text-only test collision with the phrase “legacy Codex” in the new routing note. The note now names the retained GoalSession v2 recovery protocol precisely, and the test title is scoped to that retained controller. No existing assertion was removed. The full suite subsequently passed.

The real migration also revealed that RPC logs survive the legacy close routine. The inventory now counts those logs as history while preserving checks for live pointers, leases, unfinished intents and matching processes. A regression fixture covers retained history and a live pointer in the same runtime directory.

## Assessment boundaries

- Evidence-checker tests assess the consistency of supplied reports. They do not authenticate their source or replace independent verification.
- Native tests cover file operations, rollback, drift and metadata decisions; synthetic process lists are fixtures, not proof of operating-system isolation.
- The current task provides a real native-tool smoke observation. The broader [model behavior scenarios](tests/behavior-scenarios.md), pause/cancel UI flows, and cross-version host behavior have not been independently evaluated.
- No image-model integration, paid service, GPU run or scientific acceptance is established by these checks. Private migration records and tool receipts remain outside this repository.

Re-run affected checks after changes. Repeat real-host scenarios when the host interface or routing instructions materially change; do not keep launching agents or services solely to inflate a test count.
