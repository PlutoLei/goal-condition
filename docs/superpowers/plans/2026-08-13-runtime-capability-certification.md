# Runtime Capability Certification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the accepted runtime-capability certification design so release integrity remains atomic while Claude and Codex certification are independently keyed and invalidated.

**Architecture:** A shared closed-world runtime-surface module becomes the sole manifest classification and digest implementation. The installer composes explicit stage and activate operations, the launcher becomes a thin CLI over shared controller utilities plus separate Claude and Codex runners, and machine-level capability/rollout state binds vendor-native receipts to exact source, runtime surface, and environment identities.

**Tech Stack:** Node.js ESM, `node:test`, Git-backed immutable release fixtures, canonical JSON and SHA-256, filesystem no-follow and atomic publication primitives.

**Spec:** `docs/superpowers/specs/2026-08-13-runtime-capability-certification-design.md`

## Global Constraints

- Preserve one atomic immutable release and one externally trusted whole-release manifest digest.
- New installers emit manifest schema v2; verifiers may read v1 only to prove whole-release integrity, never to certify a runtime surface.
- Every required core file is classified exactly once as `release_only`, `runtime_shared`, `claude`, or `codex`; unknown, duplicate, empty, or incomplete surfaces fail closed.
- Ordinary Claude execution is blocked while Candidate before attempt reservation, pointer publication, settings publication, or process spawn.
- Candidate has exactly one native execution path: the controller-owned fixed certification profile with full canonical preview and current-hash confirmation.
- A source-checkout receipt never enables an immutable release, and an immutable-release receipt never enables a different root or manifest digest.
- Capability state stores no credential, account identifier, prompt, transcript, sentinel bytes, settings bytes, or command stdout.
- No implementation test may stage or activate a real machine release or write production certification state.
- Existing Claude pointer, attempt, lease, rollback, exit-code, diagnostics, and Codex controller contracts remain byte/behavior compatible unless this plan explicitly changes them.
- Keep implementation, automated tests, review, native canary, local commit, push, merge, stage, activate, install, release, and production effect as separate states.

---

### Task 1: Closed-world manifest v2 and runtime surface identity

**Files:**
- Create: `goal-condition-template/scripts/lib/runtime-surfaces.mjs`
- Modify: `goal-condition-template/scripts/lib/installer.mjs`
- Modify: `goal-condition-template/codex-controller/src/release.mjs`
- Modify: `goal-condition-template/tests/install.test.mjs`
- Modify: `goal-condition-template/codex-controller/tests/runtime.test.mjs`
- Modify: `goal-condition-template/tests/static.test.mjs`

**Interfaces:**
- Produces: `CORE_FILE_CAPABILITIES`, `REQUIRED_CORE_FILES`, `classifyCoreFiles(paths)`, `runtimeSurfaceDigests(sourceEntries)`, `validateRuntimeSurfaces(manifest)`.
- Produces: `currentControllerReleaseIdentity()` returning `{source, releaseManifestDigest, runtimeSurfaceDigest}` while keeping `currentControllerReleaseDigest()` as the whole-release compatibility projection.
- Consumes: source entries with exact `{path, mode, sha256}` values already covered by the whole-release manifest.

- [ ] **Step 1: Add RED tests for exact classification and digest isolation**

```js
assert.deepEqual(Object.keys(CORE_FILE_CAPABILITIES).sort(), [...REQUIRED_CORE_FILES].sort());
assert.deepEqual(classifyCoreFiles(REQUIRED_CORE_FILES).unclassified, []);
assert.notEqual(sharedChanged.claude, original.claude);
assert.notEqual(sharedChanged.codex, original.codex);
assert.equal(releaseOnlyChanged.claude, original.claude);
assert.equal(releaseOnlyChanged.codex, original.codex);
assert.notEqual(claudeChanged.claude, original.claude);
assert.equal(claudeChanged.codex, original.codex);
assert.equal(codexChanged.claude, original.claude);
assert.notEqual(codexChanged.codex, original.codex);
```

- [ ] **Step 2: Run focused tests and record the expected missing-export/schema failures**

Run: `node --test goal-condition-template/tests/install.test.mjs goal-condition-template/codex-controller/tests/runtime.test.mjs goal-condition-template/tests/static.test.mjs`

Expected: FAIL because manifest v1 has no `runtime_surfaces` and the closed-world classification module does not exist.

- [ ] **Step 3: Implement the canonical classification and digest module**

```js
export const CAPABILITY_CLASSES = Object.freeze([
  'release_only', 'runtime_shared', 'claude', 'codex',
]);

export function runtimeSurfaceDigests(sourceEntries) {
  const entries = assertCompleteClassifiedEntries(sourceEntries);
  return Object.freeze({
    claude: digestCanonical(entries.filter(({ capability }) =>
      capability === 'runtime_shared' || capability === 'claude')),
    codex: digestCanonical(entries.filter(({ capability }) =>
      capability === 'runtime_shared' || capability === 'codex')),
  });
}
```

The canonical digest payload contains only sorted `{path, mode, sha256}` entries, never file contents or private profile material.

- [ ] **Step 4: Emit and validate manifest schema v2**

`manifestFor()` must emit exactly `schema_version`, `commit`, `source_files`, `profile_sha256`, and `runtime_surfaces`. The verifier accepts v1 for integrity-only compatibility and v2 for integrity plus runtime identity. `validateRuntimeSurfaces()` recomputes both digests from `source_files`; it never trusts the manifest's digest fields by themselves.

- [ ] **Step 5: Make checkout identity Git-bound**

For a source checkout, read exact HEAD commit, reject runtime material that differs in index or worktree from HEAD, derive Git mode and blob bytes from HEAD, and return:

```js
{
  source: { kind: 'git_checkout', root_realpath, commit },
  releaseManifestDigest: null,
  runtimeSurfaceDigest: '<runtime-specific digest>'
}
```

For an installed release, require an externally supplied whole-manifest digest and return `source.kind='immutable_release'` with the exact root and manifest digest.

- [ ] **Step 6: Run focused tests green and commit**

Run: `node --test goal-condition-template/tests/install.test.mjs goal-condition-template/codex-controller/tests/runtime.test.mjs goal-condition-template/tests/static.test.mjs`

Commit: `feat(release): add runtime surface manifest identity`

---

### Task 2: Separate immutable stage from exact-digest activation

**Files:**
- Modify: `goal-condition-template/scripts/lib/installer.mjs`
- Modify: `goal-condition-template/scripts/install.mjs`
- Modify: `goal-condition-template/tests/install.test.mjs`
- Modify: `README.md`
- Modify: `goal-condition-template/references/run-contract.md`

**Interfaces:**
- Produces: `stageRelease({repo, ref, profile, releaseRoot, faultInjector})` returning `{commit, releaseDir, manifest, manifestDigest, runtimeSurfaces}` with no link mutation.
- Produces: `activateRelease({releaseDir, expectedManifestDigest, links, backupRoot, faultInjector})` returning `{releaseDir, manifestDigest, backups}`.
- Preserves: `installRelease(options)` as `stageRelease` followed by `activateRelease` for compatibility.

- [ ] **Step 1: Add RED tests proving stage never switches links**

```js
const staged = await stageRelease({ repo, ref, profile, releaseRoot });
await assert.rejects(realpath(claudeLink), { code: 'ENOENT' });
assert.equal((await verifyRelease(staged.releaseDir, {
  expectedManifestDigest: staged.manifestDigest,
})).ok, true);
```

- [ ] **Step 2: Add RED tests proving activate binds exact physical root and digest**

Test wrong digest, a different release directory, changed release identity between inspection and cutover, and failure rollback. Every mismatch must occur before an existing runtime link is switched.

- [ ] **Step 3: Run the focused installer suite RED**

Run: `node --test goal-condition-template/tests/install.test.mjs`

Expected: FAIL because `stageRelease` and `activateRelease` do not exist and `install` currently couples materialization with cutover.

- [ ] **Step 4: Refactor the installer into stage and activate**

Move source/profile capture and immutable release creation into `stageRelease`. Move link topology, locking, backup, exact external-digest re-verification, cutover readback, and rollback into `activateRelease`. Keep the existing ancestor/device/inode protections in both phases.

- [ ] **Step 5: Add CLI commands without removing compatibility**

```text
node scripts/install.mjs stage --repo PATH --ref REF --profile FILE --release-root PATH
node scripts/install.mjs activate --release PATH --expected-manifest-digest DIGEST --link NAME=PATH ...
node scripts/install.mjs install --repo PATH --ref REF --profile FILE --release-root PATH --link NAME=PATH ...
node scripts/install.mjs verify --release PATH --expected-manifest-digest DIGEST
```

- [ ] **Step 6: Run installer and static suites green and commit**

Run: `node --test goal-condition-template/tests/install.test.mjs goal-condition-template/tests/cli.test.mjs goal-condition-template/tests/static.test.mjs`

Commit: `feat(release): separate stage from activation`

---

### Task 3: Split the mixed launcher into runtime-owned runners

**Files:**
- Create: `goal-condition-template/scripts/lib/runner-common.mjs`
- Create: `goal-condition-template/scripts/lib/runners/claude.mjs`
- Create: `goal-condition-template/scripts/lib/runners/codex.mjs`
- Modify: `goal-condition-template/scripts/launch.mjs`
- Modify: `goal-condition-template/tests/launch.test.mjs`
- Modify: `goal-condition-template/tests/cli.test.mjs`
- Modify: `goal-condition-template/tests/static.test.mjs`

**Interfaces:**
- `runner-common.mjs`: controller JSON no-follow/exclusive publication, state directory, attempt reservation, red classification, and diagnostic compiler.
- `runners/claude.mjs`: `prepareClaude`, `runClaudeAttempt`, `runClaudeReadback`, Claude pointer/lease/settings/executor lifecycle.
- `runners/codex.mjs`: `prepareCodexProbesOnly`, `runCodexLaunch`, `runCodexResume`, `runCodexFinalize`, `runCodexClose`, Codex constants and lease helpers.
- `launch.mjs`: CLI parsing/dispatch plus compatibility re-exports only; it owns no runtime attempt lifecycle.

- [ ] **Step 1: Add characterization tests before moving code**

Pin current CLI argument matrices, exit codes, stdout report shapes, session pointer bytes, attempt numbering, rollback behavior, concurrent attempt behavior, and the absence of import-time CLI side effects.

- [ ] **Step 2: Run characterization tests green on the old layout**

Run: `node --test goal-condition-template/tests/launch.test.mjs goal-condition-template/tests/cli.test.mjs`

Expected: PASS before the move; these tests are the behavior fence for the refactor.

- [ ] **Step 3: Move common controller primitives**

Keep common code free of Claude/Codex adapter imports. Runtime modules may import common primitives; common code must never import a runtime module.

- [ ] **Step 4: Move Claude lifecycle and Codex lifecycle into separate files**

The move is mechanical first. Keep exported names and values stable. Only after the full characterization suite is green may duplication be removed.

- [ ] **Step 5: Replace `launch.mjs` with a thin dispatcher**

It imports the runtime modules, parses the existing subcommands, routes by `contract.runtime`, writes the same JSON report, and preserves exit 0/1/2/3 semantics. Compatibility re-exports keep existing consumers working while runtime-surface classification follows the owning module.

- [ ] **Step 6: Run launch/CLI/full regression and commit**

Run: `node --test goal-condition-template/tests/launch.test.mjs goal-condition-template/tests/cli.test.mjs`

Run: `npm test`

Commit: `refactor(runtime): split launcher by execution surface`

---

### Task 4: Claude Candidate/Certified capability state and ordinary launch gate

**Files:**
- Create: `goal-condition-template/scripts/lib/claude-capability.mjs`
- Modify: `goal-condition-template/scripts/lib/runners/claude.mjs`
- Modify: `goal-condition-template/scripts/launch.mjs`
- Create: `goal-condition-template/tests/claude-capability.test.mjs`
- Modify: `goal-condition-template/tests/launch.test.mjs`
- Modify: `goal-condition-template/references/adapters/claude.md`

**Interfaces:**
- `readClaudeCapabilityState(path)` validates the exact schema through a descriptor/no-follow read.
- `evaluateClaudeCapability({state, source, runtimeSurfaceDigest, environment})` returns `{mode:'candidate'|'certified', reasons}` without mutating old evidence.
- `publishClaudeCapabilityState(path, state, options)` publishes mode `0600` in a mode `0700` parent through same-directory fsync and atomic rename/readback.
- `assertClaudeCertified(context)` throws `CLAUDE_CAPABILITY_UNCERTIFIED` on any mismatch.

- [ ] **Step 1: Add RED schema and drift tests**

Cover missing state, unknown/missing fields, bad modes, malformed receipts, runtime digest drift, CLI version drift, OS/arch drift, auth-mode/context drift, checkout/release source-kind mismatch, root mismatch, commit/manifest mismatch, and partial-publication fault injection.

- [ ] **Step 2: Add RED launch ordering tests**

For Candidate, assert all remain untouched: `attempts/`, `thread.json`, `settings.json`, Claude attempt lease, and executor call count. A Codex launch fixture must not read Claude capability state.

- [ ] **Step 3: Run focused tests RED**

Run: `node --test goal-condition-template/tests/claude-capability.test.mjs goal-condition-template/tests/launch.test.mjs`

Expected: FAIL because the capability module and pre-attempt gate are absent.

- [ ] **Step 4: Implement exact state/environment/source matching**

The closed-world environment is exactly `{cli_version, os, arch, auth_mode, auth_context_id}`. Accept only `claude_ai` and `api_key` auth modes. Treat `auth_context_id` as an opaque non-secret identifier and never derive or log it from a credential.

- [ ] **Step 5: Place the ordinary launch gate before all mutable Claude lifecycle work**

`runClaudeAttempt` must receive a controller-owned capability context. Its normal path calls `assertClaudeCertified` before attempt-budget check, lease claim, settings publication, pointer claim, or executor invocation. No boolean `force` or `skip` parameter is permitted.

- [ ] **Step 6: Run focused/full tests green and commit**

Run: `node --test goal-condition-template/tests/claude-capability.test.mjs goal-condition-template/tests/launch.test.mjs`

Run: `npm test`

Commit: `feat(claude): gate launches on runtime certification`

---

### Task 5: Controller-owned fixed Claude certification workflow

**Files:**
- Create: `goal-condition-template/scripts/lib/claude-certification.mjs`
- Modify: `goal-condition-template/scripts/lib/runners/claude.mjs`
- Modify: `goal-condition-template/scripts/launch.mjs`
- Create: `goal-condition-template/tests/claude-certification.test.mjs`
- Modify: `goal-condition-template/tests/cli.test.mjs`
- Modify: `goal-condition-template/references/adapters/claude.md`
- Modify: `goal-condition-template/SKILL.md`

**Interfaces:**
- `compileClaudeCertificationContract({source, targetRoot, stateRoot, authMode, authContextId, sentinelSha256})` returns canonical contract bytes, preview, and hash from one fixed closed-world profile.
- `classifyClaudeCanaryBlocker(result)` returns only `blocked`, `candidate_rejected`, or `controller_error`; API 429/subscription/session/network/provider failures are `blocked`.
- `buildClaudeCertificationReceipt(evidence)` returns a closed-world receipt only when all five condition IDs pass.
- `runClaudeCertification(options)` is the sole Candidate execution entry and accepts the exact compiled profile plus current confirmed hash, not an arbitrary contract or a bypass flag.

- [ ] **Step 1: Add RED contract/hash tests**

Prove every disposable path or sentinel change changes canonical bytes and SHA-256, the full preview embeds authoritative JSON, a stale confirmation fails before preflight, and arbitrary contracts cannot enter the certification path.

- [ ] **Step 2: Add RED five-condition receipt tests**

```js
const ids = [
  'ambient-deny-control',
  'isolated-adapter-candidate',
  'sentinel-output',
  'flag-settings-hook',
  'baseline-preserved',
];
for (const id of ids) {
  assert.throws(() => buildClaudeCertificationReceipt(oneRed(id)), {
    code: 'CLAUDE_CERTIFICATION_INCOMPLETE',
  });
}
```

- [ ] **Step 3: Add RED external-blocker tests**

Measured API/quota/provider envelopes remain Candidate, do not overwrite an existing receipt, and never become `candidate_rejected` merely because the provider was unavailable.

- [ ] **Step 4: Run focused tests RED**

Run: `node --test goal-condition-template/tests/claude-certification.test.mjs goal-condition-template/tests/cli.test.mjs`

Expected: FAIL because no fixed certification compiler/controller exists.

- [ ] **Step 5: Implement prepare/confirm/run commands**

The prepare command writes the disposable canonical contract and prints its complete preview/hash without launching. The run command requires that exact file/hash, captures a trusted baseline binding, executes the control lane and normal Claude adapter lane, independently verifies postflight/baseline, builds the five-condition receipt, and atomically publishes Certified only on all-green evidence.

- [ ] **Step 6: Run fake-executor green paths and all-red fault injection**

No fake executor may write machine-level production state; tests supply disposable state roots and deterministic environment/source identities.

- [ ] **Step 7: Run focused/full tests green and commit**

Run: `node --test goal-condition-template/tests/claude-certification.test.mjs goal-condition-template/tests/cli.test.mjs goal-condition-template/tests/launch.test.mjs`

Run: `npm test`

Commit: `feat(claude): add controller-owned certification canary`

---

### Task 6: Decouple Codex rollout integrity from runtime certification

**Files:**
- Modify: `goal-condition-template/codex-controller/src/rollout.mjs`
- Modify: `goal-condition-template/codex-controller/src/cli.mjs`
- Modify: `goal-condition-template/codex-controller/src/execution.mjs`
- Modify: `goal-condition-template/codex-controller/tests/rollout.test.mjs`
- Modify: `goal-condition-template/codex-controller/tests/cli.test.mjs`
- Modify: `goal-condition-template/references/codex-goal-session-v2.md`
- Modify: `goal-condition-template/references/adapters/codex.md`

**Interfaces:**
- Rollout schema v5 stores exact `release_manifest_digest` and `runtime_surface_digest` separately.
- Canary receipt replaces `controller_release_digest` with exact `release_manifest_digest` plus `runtime_surface_digest`.
- `assertLiveRollout(stateRoot, {releaseManifestDigest, runtimeSurfaceDigest})` verifies both independent bindings.

- [ ] **Step 1: Add RED digest-isolation and migration tests**

Prove Claude-only/release-only change keeps Codex runtime certification, runtime-shared/Codex change invalidates it, and every schema-v4 enabled state migrates to schema-v5 `canary` with no inherited receipt.

- [ ] **Step 2: Run rollout/CLI tests RED**

Run: `node --test goal-condition-template/codex-controller/tests/rollout.test.mjs goal-condition-template/codex-controller/tests/cli.test.mjs`

Expected: FAIL because schema v4 binds one whole-release digest and migration still preserves old enabled receipts.

- [ ] **Step 3: Implement schema v5 and fail-closed migration**

Never reinterpret a v4 whole-release digest as a runtime surface digest. Disabled stays disabled; any old live state becomes canary for the verified current release/runtime surface and must obtain a new receipt before enabled.

- [ ] **Step 4: Thread both identities through controller commands**

All live controller entry points verify whole-release integrity first and runtime certification second. Preserve controller behavior and single-turn Candidate semantics.

- [ ] **Step 5: Run controller/full tests green and commit**

Run: `node --test goal-condition-template/codex-controller/tests/*.test.mjs`

Run: `npm test`

Commit: `feat(codex): key rollout by runtime surface`

---

### Task 7: Documentation closure, full verification, and independent review

**Files:**
- Modify: `README.md`
- Modify: `goal-condition-template/SKILL.md`
- Modify: `goal-condition-template/references/run-contract.md`
- Modify: `goal-condition-template/references/adapters/claude.md`
- Modify: `goal-condition-template/references/adapters/codex.md`
- Modify: `goal-condition-template/tests/static.test.mjs`

**Interfaces:**
- Documents expose stage versus activate, integrity versus certification, Candidate behavior, exact certification preview/confirmation, source-kind non-transferability, migration, and separate delivery-state reporting.

- [ ] **Step 1: Add/adjust static behavioral documentation checks**

Checks must assert user-visible workflow and shipped paths, not incidental prose layout.

- [ ] **Step 2: Run every focused suite and the full suite**

Run: `git diff --check`

Run: `npm test`

Expected: exit 0, zero failures.

- [ ] **Step 3: Run the mutation-oriented requirement audit**

For every design acceptance item, identify the production mutation that its test would catch: missing classification, wrong surface membership, stage link switch, digest mismatch bypass, Candidate side effect, each red canary condition, state partial write, source transfer, environment drift, and old rollout receipt inheritance.

- [ ] **Step 4: Request independent code review**

Review the complete diff from `4595518` to final HEAD against the accepted design and this plan. Fix every Critical and Important issue with a fresh RED/GREEN cycle, then rerun `git diff --check` and `npm test`.

- [ ] **Step 5: Commit final documentation/review fixes**

Commit: `docs(runtime): document capability certification workflow`

- [ ] **Step 6: Stop before live Claude certification**

Probe Claude API health only after offline implementation, full tests, and review are green. If healthy, compile the disposable certification contract and show its complete authoritative canonical JSON plus current SHA-256 to the user. Do not launch until that exact hash is explicitly confirmed.
