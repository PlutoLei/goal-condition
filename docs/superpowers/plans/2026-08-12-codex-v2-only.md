# Codex V2-Only Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GoalSession v2 the only callable Codex lifecycle while preserving one-way v1 migration, the private AttemptManifest launcher ABI, and unchanged Claude behavior.

**Architecture:** Replace legacy-oriented rollout and CLI surfaces with a V2-native release gate and one-way migration command. Keep the shared run-contract validator behind the private AttemptManifest boundary, remove every Codex live fallback, and publish a Codex-only installed release from the merged GitHub commit.

**Tech Stack:** Node.js 24.15+, ESM, `node:test`, `node:sqlite`, canonical JSON/SHA-256 artifacts, Codex app-server, commit-pinned immutable installer, Git/GitHub CLI.

## Global Constraints

- Change only the Codex control plane, routing, documentation, tests, and installed Codex release.
- Do not change Claude adapter behavior or shared run-contract schema semantics.
- Codex controller absence, disabled mode, release mismatch, or invalid migration must fail closed without legacy fallback.
- Preserve exact turn-input attribution, snapshot, verifier, lease, and finalize invariants.
- Keep `goal-condition-template/SKILL.md` below 200 lines.
- Use `apply_patch` for source edits, test red before implementation green, and make no completion claim without fresh full verification.

---

### Task 1: Replace Legacy Rollout With a V2-Native Gate

**Files:**
- Modify: `goal-condition-template/codex-controller/src/rollout.mjs`
- Modify: `goal-condition-template/codex-controller/tests/rollout.test.mjs`

**Interfaces:**
- Produces: `ROLLOUT_MODES = ['disabled', 'canary', 'enabled']`.
- Produces: `ensureRolloutState(path, { releaseManifestDigest }) -> normalized state` with one-time schema-v3 conversion.
- Preserves: `certifyRolloutCanary`, `transitionRollout`, `writeRolloutMode`, and `assertLiveRollout` as V2-only gates.

- [ ] **Step 1: Write failing V2 rollout tests**

Replace legacy-mode expectations with exact assertions equivalent to:

```js
assert.deepEqual(ROLLOUT_MODES, ['disabled', 'canary', 'enabled']);
assert.equal(transitionRollout('disabled', 'canary'), 'canary');
assert.equal(transitionRollout('canary', 'enabled', { canaryReceipt: receipt }), 'enabled');
assert.throws(() => transitionRollout('disabled', 'enabled'), hasCode('ROLLOUT_TRANSITION_INVALID'));
assert.throws(() => transitionRollout('canary', 'enabled'), hasCode('ROLLOUT_CANARY_REQUIRED'));
```

Add table-driven schema-v3 migration cases for `shadow→disabled`, `opt-in→canary`, and `default|legacy-freeze→enabled`. Assert the file is atomically rewritten as schema version 4, invalid old shapes fail with `ROLLOUT_STATE_INVALID`, missing state is disabled, and enabled state rejects a different release digest.

- [ ] **Step 2: Run the rollout test and prove red**

Run:

```bash
node --test goal-condition-template/codex-controller/tests/rollout.test.mjs
```

Expected: FAIL because the implementation still exposes `shadow`, `opt-in`, `default`, and `legacy-freeze` and writes schema version 3.

- [ ] **Step 3: Implement schema-v4 rollout and conversion**

Use the closed transition graph:

```js
const NEXT = Object.freeze({
  disabled: new Set(['canary']),
  canary: new Set(['disabled', 'enabled']),
  enabled: new Set(['disabled', 'canary']),
});
```

New `canary` and `enabled` states bind `release_manifest_digest`; only `enabled` stores a certified canary receipt. `ensureRolloutState` accepts the exact old schema-v3 shape, maps it once, writes canonical schema-v4 bytes through a temporary file plus rename, and returns only the V2 vocabulary. `assertLiveRollout` blocks `disabled` and requires the installed release digest for both live modes.

- [ ] **Step 4: Run rollout tests green**

Run the same targeted command and require exit 0.

- [ ] **Step 5: Commit the rollout unit**

```bash
git add goal-condition-template/codex-controller/src/rollout.mjs goal-condition-template/codex-controller/tests/rollout.test.mjs
git commit -m "refactor(codex): make rollout v2-only"
```

### Task 2: Make the Controller Surface V2-Only

**Files:**
- Create: `goal-condition-template/codex-controller/src/migration.mjs`
- Create: `goal-condition-template/codex-controller/tests/migration.test.mjs`
- Modify: `goal-condition-template/codex-controller/src/cli.mjs`
- Modify: `goal-condition-template/codex-controller/src/index.mjs`
- Modify: `goal-condition-template/codex-controller/tests/cli.test.mjs`
- Delete: `goal-condition-template/codex-controller/src/adoption.mjs`
- Delete: `goal-condition-template/codex-controller/src/shadow.mjs`
- Delete: `goal-condition-template/codex-controller/tests/adoption.test.mjs`
- Delete: `goal-condition-template/codex-controller/tests/shadow.test.mjs`

**Interfaces:**
- Produces: `migrateV1Contract({ contract, sessionId, currentStateDigest, originalBaseline })`.
- Produces CLI command: `migrate-v1 --state-root PATH --input FILE`.
- Removes CLI commands: `adopt`, `shadow`.

- [ ] **Step 1: Write failing CLI and migration tests**

Assert the exact command set contains `migrate-v1` and excludes `adopt` and `shadow`. Move the adoption fixture into `migration.test.mjs` and assert:

```js
const result = migrateV1Contract({
  contract,
  sessionId: 'migrated-session',
  currentStateDigest: 'a'.repeat(64),
  originalBaseline: null,
});
assert.equal(result.session.status, 'AwaitingConfirmation');
assert.equal(result.session.confirmation_receipts.length, 0);
assert.equal(result.provenance.legacy_confirmation, 'unverified');
assert.equal(result.provenance.certifies_pre_migration_state, false);
```

Add CLI negative assertions that `adopt` and `shadow` return `CLI_COMMAND_UNKNOWN`. Update every live CLI fixture to set `canary`, and update the mode test to require initial `disabled` plus canary-to-enabled certification.

- [ ] **Step 2: Run targeted tests and prove red**

```bash
node --test goal-condition-template/codex-controller/tests/cli.test.mjs goal-condition-template/codex-controller/tests/migration.test.mjs
```

Expected: FAIL because `migrate-v1` and `migrateV1Contract` do not exist and the old commands remain callable.

- [ ] **Step 3: Implement the one-way migration surface**

Move the validated conversion logic into `migration.mjs`, rename adoption-specific identifiers to migration terminology, and preserve these facts in immutable provenance:

```js
{
  provenance_version: 1,
  baseline_provenance: originalBaseline === null ? 'migrated_at_current_state' : 'v1_original',
  legacy_confirmation: 'unverified',
  certifies_pre_migration_state: false,
}
```

In `cli.mjs`, remove the shadow import, handler, and command declaration. Replace `adopt` with `migrate-v1`, store the source artifact as `v1-migration-input`, and return `command: 'migrate-v1'`. Route mode reads and live gates through schema-v4 `ensureRolloutState`.

- [ ] **Step 4: Remove legacy production and test modules**

Delete `adoption.mjs`, `shadow.mjs`, and their old tests only after all imports and exports have moved. Do not delete the shared validator or v1 fixture used as migration input.

- [ ] **Step 5: Run CLI, migration, rollout, and controller tests green**

```bash
node --test goal-condition-template/codex-controller/tests/cli.test.mjs goal-condition-template/codex-controller/tests/migration.test.mjs goal-condition-template/codex-controller/tests/rollout.test.mjs
npm --prefix goal-condition-template/codex-controller test
```

Require both commands to exit 0.

- [ ] **Step 6: Commit the controller surface**

```bash
git add goal-condition-template/codex-controller/src goal-condition-template/codex-controller/tests
git commit -m "refactor(codex): remove legacy execution surface"
```

### Task 3: Make AttemptManifest the Only Internal Launcher Name

**Files:**
- Modify: `goal-condition-template/codex-controller/src/projector.mjs`
- Modify: `goal-condition-template/codex-controller/src/execution.mjs`
- Modify: `goal-condition-template/codex-controller/src/cli.mjs`
- Modify: `goal-condition-template/codex-controller/tests/projector.test.mjs`
- Modify: affected controller tests that assert projection output text

**Interfaces:**
- Preserves: the launcher payload field shape and shared closed-world validation.
- Changes: error code `V1_PROJECTION_INVALID` to `ATTEMPT_MANIFEST_INVALID`.
- Names: local variables and user-facing descriptions use `attemptManifest` / `AttemptManifest`; generic serialized field `manifest` may remain for backward-compatible V2 envelopes.

- [ ] **Step 1: Write the failing terminology and invariant tests**

Rename the projector test to “AttemptManifest remains closed-world while the envelope stays Codex-only”. Assert `validateContract(result.manifest)` is empty, every active Condition has one mapping, and a malformed projection throws `ATTEMPT_MANIFEST_INVALID`. Add a source-surface test that production controller files contain neither `V1_PROJECTION_INVALID` nor the phrases `v1 manifest` and `legacy Codex`.

- [ ] **Step 2: Run projector and source-surface tests red**

```bash
node --test goal-condition-template/codex-controller/tests/projector.test.mjs goal-condition-template/tests/static.test.mjs
```

Expected: FAIL on the old error code and old public terminology.

- [ ] **Step 3: Rename the private boundary without changing its wire shape**

Use `attemptManifest` for internal variables and messages, keep `version: 1` and the exact shared schema payload, and emit:

```js
throw projectionError(
  'ATTEMPT_MANIFEST_INVALID',
  'projected AttemptManifest failed closed-world validation',
  diagnostics.map((diagnostic) => diagnostic.code),
);
```

Update `execution.mjs` and `cli.mjs` labels and comments while preserving contract hashes, blob kind `attempt-manifest`, snapshot behavior, and the stable projection result shape.

- [ ] **Step 4: Run projector and full controller tests green**

```bash
node --test goal-condition-template/codex-controller/tests/projector.test.mjs
npm --prefix goal-condition-template/codex-controller test
```

- [ ] **Step 5: Commit the private-boundary rename**

```bash
git add goal-condition-template/codex-controller
git commit -m "refactor(codex): name the private attempt manifest"
```

### Task 4: Rewrite the Skill and Release Surface Around V2-Only Routing

**Files:**
- Modify: `goal-condition-template/SKILL.md`
- Modify: `goal-condition-template/references/codex-goal-session-v2.md`
- Modify: `goal-condition-template/references/adapters/codex.md`
- Modify: `goal-condition-template/scripts/lib/installer.mjs`
- Modify: `goal-condition-template/tests/static.test.mjs`
- Modify: `goal-condition-template/tests/static.test.mjs`
- Include: `docs/superpowers/specs/2026-08-12-codex-v2-only.md`
- Include: `docs/decisions/2026-08-12-codex-v2-only.md`

**Interfaces:**
- Router: Codex GoalSession v2 only; Claude shared run contract only.
- Installer core: includes `migration.mjs`; excludes `adoption.mjs` and `shadow.mjs`.
- Skill: remains below 200 lines and has no Codex V1 live instructions.

- [ ] **Step 1: Write failing static and installer assertions**

Require the Skill to contain:

```text
Codex: GoalSession v2 only
Claude: Compile shared run contract
disabled → canary → enabled
migrate-v1
不得回退到 Codex v1
```

Require it not to contain `legacy Codex`, `Claude/legacy`, `shadow 保留 v1 live`, or `已有 v1 task 默认继续 legacy`. Assert `REQUIRED_CORE_FILES` includes `codex-controller/src/migration.mjs` and excludes the removed adoption/shadow modules.

- [ ] **Step 2: Run static and installer tests red**

```bash
node --test goal-condition-template/tests/static.test.mjs
```

Expected: FAIL on the old router text and installer core list.

- [ ] **Step 3: Rewrite the production Skill**

Make Classify send an old Codex contract to `migrate-v1`; make a new Codex task enter V2; make controller failure explicit and non-fallback. Label compile/validate/preview/preflight/postflight/close sections as the Claude shared-contract branch. Preserve all V2 authority, revision, receipt, verifier, and completion rules.

- [ ] **Step 4: Update V2 protocol and adapter references**

Document schema-v4 V2 rollout, the one-way migration command, and AttemptManifest terminology. Remove executable legacy Codex instructions while retaining explicit “v1 input” wording only in the migration section and historical links.

- [ ] **Step 5: Update installer core and verify Skill size**

Replace the two removed production files with `migration.mjs` in `REQUIRED_CORE_FILES`, then run:

```bash
wc -l goal-condition-template/SKILL.md
```

Expected: an integer below 200.

- [ ] **Step 6: Run root and controller suites green**

```bash
npm test
npm --prefix goal-condition-template/codex-controller test
```

- [ ] **Step 7: Commit docs, Skill, installer, and tests**

```bash
git add README.md docs goal-condition-template/SKILL.md goal-condition-template/references goal-condition-template/scripts/lib/installer.mjs goal-condition-template/tests
git commit -m "docs(goal-condition): make Codex routing v2-only"
```

### Task 5: Verify, Publish, Merge, Install, and Smoke the Merged Release

**Files:**
- No additional source files unless verification exposes a defect.
- Runtime outputs: immutable release directory, external manifest digest, Codex skill symlink, isolated smoke state and target directories.

**Interfaces:**
- GitHub: branch `agent/codex-v2-only` into `main`.
- Installed Skill: Codex link points to a release materialized from the merged `main` commit.

- [ ] **Step 1: Run fresh pre-publish verification**

```bash
git diff --check
npm test
npm --prefix goal-condition-template/codex-controller test
git status --short
```

Require zero test failures and only intended files.

- [ ] **Step 2: Push and open a ready pull request**

Check `gh auth status`, push `agent/codex-v2-only`, create a PR targeting `main`, and include root cause, behavior change, migration path, and exact test commands. The user has already instructed direct end-to-end integration, so mark it ready rather than draft.

- [ ] **Step 3: Read automated review and merge**

Wait for available GitHub/Cursor Bugbot review and required checks. Address actionable findings with tests. When checks are green, merge into `main` without force-push, fetch the merged commit, and verify the PR reports `MERGED`.

- [ ] **Step 4: Install only the Codex link from the merged commit**

Use the existing private profile and installer topology discovered from the current installation. Run the commit-pinned installer with only `--link codex=...`, retain the printed external `manifestDigest`, and verify the new immutable release with:

```bash
node goal-condition-template/scripts/install.mjs verify --release NEW_RELEASE --expected-manifest-digest MANIFEST_DIGEST
```

Do not switch the Claude link.

- [ ] **Step 5: Run installed V2-only smoke**

Against the installed release, assert:

```js
commandNames().includes('migrate-v1') === true
commandNames().includes('adopt') === false
commandNames().includes('shadow') === false
```

Read mode through the installed CLI and confirm only `disabled|canary|enabled`. In isolated state and target directories, run `init → preview → confirm → prepare → launch → verify → finalize → close` for a minimal safe GoalSession v2 canary, then export the Session and require `status: 'Complete'`, one controller-certified final Attempt, no bypasses, and a released lease. Re-run the release verifier after the smoke.

- [ ] **Step 6: Verify merged and installed identities**

Confirm the installed manifest commit equals the merged `origin/main` commit, the Codex symlink resolves to that release, the Claude symlink is unchanged, and `git status --short` is clean in the feature worktree.

- [ ] **Step 7: Record final evidence**

Report the merged PR URL, merge commit, installed release path, trusted manifest digest, test counts, smoke Session ID, and any intentionally retained `version: 1` private format fields.
