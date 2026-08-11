# Codex GoalSession v2 Controlled Execution Implementation Plan

> **Execution:** Use `superpowers:executing-plans` task by task. Every production change follows RED → GREEN → REFACTOR and is committed only after its focused tests pass.

**Goal:** Finish the Codex-only GoalSession v2 path so a confirmed stable Goal can execute, revise Boundary/Condition inside its Authority without full reconfirmation, recover safely, certify controller-owned evidence, adopt legacy v1 explicitly, and become the locally installed Codex default.

**Architecture:** Keep the existing v1 Run Contract and Codex launcher as the only live side-effect boundary. GoalSession v2 is a supervising control plane: it compiles immutable v1 Attempt manifests, persists a LaunchIntent before calling the launcher, binds the returned native thread to a LaunchReceipt, runs independent verifiers, and creates a new immutable Attempt for an Authority-preserving design revision. Grill remains a design-review technique and is never a runtime component.

**Runtime:** Node.js 24.15+, `node:sqlite`, existing `scripts/launch.mjs` Codex functions and app-server protocol, built-in `node:test`, no new root dependency.

## Root cause and decision

The repeated-contract failure is not caused by the confirmation UI. v1 hashes four lifecycles together: stable Goal, user-granted Authority, dynamic Design, and one execution Attempt. Any legitimate Design evolution therefore appears to be a new authorization.

The minimal fallback would keep v1 live and add an Authority sidecar that suppresses repeated confirmation when a textual diff appears safe. It has a smaller implementation radius, but it still infers policy from two monolithic contracts, cannot bind Evidence to typed revisions cleanly, and makes crash recovery ambiguous.

The selected thorough design keeps Goal and Authority as stable, receipt-backed control-plane state; Design as typed revisions; and v1 as an immutable per-Attempt projection. This adds a controller and migration cost, but removes the aggregation defect rather than masking its symptom. The existing launcher is reused, so the change is Codex-only and the proven side-effect code is not duplicated.

## Non-negotiable invariants

- Claude adapter, shared v1 schema, shared workflow and Claude snapshots do not change.
- Grill is absent from controller commands, runtime prompts and recovery.
- A Goal or Authority expansion cannot auto-apply.
- An Authority-preserving Design revision does not require full confirmation.
- A LaunchIntent is durable before any native turn can start.
- An ambiguous launch never causes automatic duplicate `turn/start`.
- One writable Attempt at most owns a target root.
- Executor output is candidate information; only controller-owned verifier evidence can certify completion.
- A bypass or unresolved out-of-band change prevents Certified Complete.
- Only the Codex skill symlink is switched during local rollout; the Claude skill remains on its prior release.

## Task 1: Freeze controlled-execution RED tests

**Files:**

- Add: `goal-condition-template/codex-controller/tests/capabilities.test.mjs`
- Add: `goal-condition-template/codex-controller/tests/attempt.test.mjs`
- Add: `goal-condition-template/codex-controller/tests/execution.test.mjs`
- Add: `goal-condition-template/codex-controller/tests/verification.test.mjs`
- Add: `goal-condition-template/codex-controller/tests/recovery.test.mjs`
- Add: `goal-condition-template/codex-controller/tests/adoption.test.mjs`
- Add: `goal-condition-template/codex-controller/tests/rollout.test.mjs`
- Modify: `goal-condition-template/codex-controller/tests/cli.test.mjs`

Write failing tests for:

- capability levels `ENFORCED`, `DETECTED`, `DECLARED`, `UNAVAILABLE` and hard-prohibition fail-closed;
- closed-world Attempt, LaunchIntent and LaunchReceipt records;
- intent-before-launch ordering and receipt-after-observed-turn ordering;
- no Attempt consumption before native `turn/start`;
- exclusive writable-root leases, including stale lease reconciliation rather than takeover;
- independent command verification with hashed output only;
- Candidate → Verified → Certified and bypass preventing Certified;
- ambiguous launch recovery using native readback without a second launch;
- explicit legacy adoption with `adopted_at_current_state` provenance;
- `shadow`, `opt-in`, `default`, `legacy-freeze` rollout transitions;
- CLI commands rejecting unknown flags and never invoking Grill.

Run:

```bash
cd goal-condition-template/codex-controller
npm test
```

Expected: new tests fail because the production modules and commands do not exist.

Commit:

```bash
git add goal-condition-template/codex-controller/tests
git commit -m "test(goal-session): freeze controlled execution contracts"
```

## Task 2: Implement capability gate and Attempt value objects

**Files:**

- Add: `goal-condition-template/codex-controller/src/capabilities.mjs`
- Add: `goal-condition-template/codex-controller/src/attempt.mjs`
- Modify: `goal-condition-template/codex-controller/src/domain.mjs`
- Modify: `goal-condition-template/codex-controller/schema/goal-session-v2.schema.json`
- Modify: tests from Task 1

Implement:

- a closed capability matrix tied to current Codex sandbox/readback facts;
- fail-closed hard-prohibition assessment;
- canonical, hash-bound Attempt, LaunchIntent, one-time capability and LaunchReceipt objects;
- HMAC key use through a narrow signer API without exporting key bytes;
- strict Attempt validation in GoalSession state;
- transitions that create a real Attempt only after a real native turn receipt exists.

Run focused tests, then the controller suite. Commit production and tests together.

## Task 3: Extend the store with atomic root leases and intent lookup

**Files:**

- Modify: `goal-condition-template/codex-controller/src/store.mjs`
- Modify: `goal-condition-template/codex-controller/tests/store.test.mjs`
- Modify: `goal-condition-template/codex-controller/tests/store-crash-child.mjs`
- Modify: `goal-condition-template/codex-controller/tests/execution.test.mjs`

Add strict SQLite tables for target-root leases and launch-intent indexes. Provide transactional APIs to:

- acquire all canonical target roots in sorted order;
- reject overlapping live owners;
- mark expired leases `reconciliation_required` rather than stealing them;
- heartbeat and release only with the matching owner token;
- locate an outstanding LaunchIntent by `run_id`;
- atomically commit Attempt state, blobs, ledger event and lease mutation.

Inject crashes before and after intent commit, lease acquisition and receipt commit. Reopen the store and prove event/blob integrity and no duplicate owner.

## Task 4: Build the GoalSession execution supervisor over the v1 adapter

**Files:**

- Add: `goal-condition-template/codex-controller/src/execution.mjs`
- Modify: `goal-condition-template/codex-controller/src/projector.mjs`
- Modify: `goal-condition-template/codex-controller/src/index.mjs`
- Modify: `goal-condition-template/codex-controller/tests/execution.test.mjs`
- Modify: `goal-condition-template/codex-controller/tests/projector.test.mjs`

Implement a dependency-injected supervisor that:

1. reads a confirmed Ready GoalSession;
2. projects and persists Context Package, Projection Proof and immutable v1 manifest;
3. verifies projection bytes and current context hashes;
4. acquires writable-root leases;
5. writes LaunchIntent and one-time capability;
6. calls the existing `prepareCodexProbesOnly` and `runCodexLaunch` functions;
7. binds observed `thread_id` and native attempt facts into a LaunchReceipt;
8. transitions to Evaluating for a candidate, or to a truthful blocked/reconciliation state;
9. uses existing `runCodexResume` only inside the same immutable Attempt;
10. starts a new immutable Attempt after an Authority-preserving Design revision.

The supervisor must never call Grill, infer Authority, or copy app-server RPC logic.

## Task 5: Add controller-owned verification and certification

**Files:**

- Add: `goal-condition-template/codex-controller/src/verification.mjs`
- Modify: `goal-condition-template/codex-controller/src/evidence.mjs`
- Modify: `goal-condition-template/codex-controller/src/domain.mjs`
- Modify: `goal-condition-template/codex-controller/tests/verification.test.mjs`
- Modify: `goal-condition-template/codex-controller/tests/evidence.test.mjs`

Run verifier commands directly from the controller with no shell interpolation, bounded output, fixed cwd inside the authorized roots and explicit timeout. Persist only output hashes plus bounded diagnostics; keep raw output in content-addressed blobs when needed.

Bind every Evidence record to root baseline, current Design revision, Context Package, verifier version, runtime version and Attempt. Commit Evidence and status changes atomically. Require:

- all current Conditions passing for Verified;
- no bypass, state-integrity failure, out-of-band change or authorization violation for Certified;
- existing Codex finalize and raw readback receipts before Session Complete;
- failed verifiers to produce typed diagnostics suitable for a revision or same-Attempt resume.

## Task 6: Implement recovery and bypass reconciliation

**Files:**

- Add: `goal-condition-template/codex-controller/src/recovery.mjs`
- Modify: `goal-condition-template/codex-controller/src/execution.mjs`
- Modify: `goal-condition-template/codex-controller/tests/recovery.test.mjs`
- Modify: `goal-condition-template/codex-controller/tests/execution.test.mjs`

Recovery order is fixed:

1. verify event chain and blobs;
2. inspect the target-root lease and outstanding LaunchIntent;
3. read native thread/turn history through a dependency-injected readback adapter;
4. compare Attempt snapshot and workspace digest;
5. validate Evidence dependencies;
6. resume Evaluating, enter Revising, or remain ReconciliationRequired.

If native readback cannot prove whether `turn/start` happened, preserve the intent and return ReconciliationRequired. Never call launch again automatically. Detect turns not covered by a LaunchReceipt as `CONTROL_PLANE_BYPASS`; invalidate affected Evidence and require explicit reconciliation without deleting user changes.

## Task 7: Add explicit legacy adoption and rollout state

**Files:**

- Add: `goal-condition-template/codex-controller/src/adoption.mjs`
- Add: `goal-condition-template/codex-controller/src/rollout.mjs`
- Modify: `goal-condition-template/codex-controller/src/compiler.mjs`
- Modify: `goal-condition-template/codex-controller/src/store.mjs`
- Modify: `goal-condition-template/codex-controller/tests/adoption.test.mjs`
- Modify: `goal-condition-template/codex-controller/tests/rollout.test.mjs`

Adoption imports a validated Codex v1 contract into a Draft GoalSession with immutable `legacy_import` provenance. It never treats a historical v1 confirmation as a v2 Receipt. Missing original baseline becomes `adopted_at_current_state`; only post-adoption modifications are certifiable.

Rollout state is stored outside the release tree and supports `shadow`, `opt-in`, `default` and `legacy-freeze`. Transitions are closed and audited; rollback freezes active v2 Sessions rather than silently converting them to v1.

## Task 8: Expose closed CLI commands

**Files:**

- Modify: `goal-condition-template/codex-controller/src/cli.mjs`
- Modify: `goal-condition-template/codex-controller/tests/cli.test.mjs`

Add strict commands:

```text
capabilities  adopt  prepare  launch  resume  verify
finalize      reconcile  close  mode
```

Every command accepts an exact flag set, emits one canonical JSON result and has dependency injection for tests. Live commands report their actual side-effect/result level instead of the shadow-era `live_execution:false`. No command accepts free-form interrogation or Grill flags.

## Task 9: Convert the Codex Skill from shadow to controlled default

**Files:**

- Modify: `goal-condition-template/SKILL.md`
- Modify: `goal-condition-template/references/adapters/codex.md`
- Add: `goal-condition-template/references/codex-goal-session-v2.md`
- Modify: release closure tests and installer manifests as required
- Add/modify: skill pressure fixtures and reports

Keep `SKILL.md` below 200 lines. Route only Codex to GoalSession v2 when rollout mode and capabilities allow it. The user experience is:

```text
Compile Goal + Maximum Authority + initial Design
→ Preview/confirm once
→ controlled Attempt
→ controller verifies
→ typed Design revision inside Authority
→ next Attempt without full reconfirmation
→ reauthorize only for Goal/Authority/risk/budget expansion
```

First run RED pressure against the currently installed shadow Skill. Then run at least five fresh-agent repetitions per GREEN pressure variant. Required scenarios include urgency, reviewer false-green, external path discovery, objective projection correction and explicit bypass. Verify that agents never invoke Grill at runtime and never claim a dynamic revision was applied without a controller receipt.

## Task 10: Regression, mutation, release and local Codex-only install

**Files:**

- Modify: release manifest/closure tests only as required by added production files
- Add: `docs/superpowers/reports/2026-08-11-codex-goal-session-v2-controlled-execution.md`

Run:

```bash
npm test
cd goal-condition-template/codex-controller && npm test
```

Also run deterministic model sequences, crash injection, mutation tests, schema validation, Skill line-count/closure checks, secret scans and a diff proving Claude/shared-v1 behavior did not change.

Commit the finished branch. Build a release from the exact commit, verify its manifest digest, and switch only:

```text
/Users/lei/.codex/skills/goal-condition
```

Leave `/Users/lei/.claude/skills/goal-condition` on its previous release. Read both symlinks back and verify the installed files against the release manifest.

## Task 11: Run a bounded real Codex canary and enable default

Create a disposable, non-temporary target root outside Controller state. Use a minimal Goal that writes one harmless artifact and a deterministic verifier. Set strict turn/token/time limits. Execute the full live sequence:

```text
init → confirm → prepare → launch → candidate
→ controller verify → finalize → runtime readback → certified complete → close
```

Then run an Authority-preserving Condition revision and prove it creates a new Attempt without a second full confirmation. Inject one ambiguous launch in a mocked boundary to prove recovery does not duplicate `turn/start`.

Only after readback proves the real canary is Certified Complete, set Codex rollout mode to `default`. Export the audit record, remove disposable canary data safely, and record exact test counts, commit, installed release digest, native thread/turn receipts and remaining limitations in the final report.
