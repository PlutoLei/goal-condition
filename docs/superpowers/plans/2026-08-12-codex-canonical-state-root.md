# Codex Canonical Controller State Root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ordinary Codex GoalSession V2 commands share one mechanically resolved machine-level controller state root while retaining an explicit advanced override.

**Architecture:** A focused `state-root.mjs` module selects the controller root by strict precedence and returns the chosen bytes without silently normalizing invalid higher-precedence input. The existing CLI resolves that path once before dispatch, so every stateful command receives the same explicit `flags['state-root']`; all existing physical-path and target-isolation checks remain downstream authorities.

**Tech Stack:** Node.js 24.15+, ECMAScript modules, `node:test`, existing GoalSession V2 controller and immutable installer.

## Global Constraints

- Modify Codex-only controller, Skill routing, installer inventory, and Codex protocol documentation; do not change Claude adapters or shared run-contract schemas.
- Resolution precedence is explicit `--state-root`, `GOAL_CONDITION_CODEX_STATE_ROOT`, absolute `XDG_STATE_HOME`, then `<home>/.local/state/goal-condition/codex-v2`.
- A malformed higher-precedence value fails closed; it never falls through.
- Alternative state roots remain separate deployment namespaces whose missing rollout state is `disabled`.
- Existing temporary-path, physical ancestor, permission, target-root isolation, release digest, canary, and lease gates remain authoritative.
- The new release must run a fresh dynamic-revision promotion canary before `enabled`.
- Machine-global `session_id` and `run_id` values are controller-generated 128-bit random IDs returned by the preceding command; callers do not select them.

---

### Task 1: Pure State-Root Resolver

**Files:**
- Create: `goal-condition-template/codex-controller/src/state-root.mjs`
- Modify: `goal-condition-template/codex-controller/src/index.mjs`
- Create: `goal-condition-template/codex-controller/tests/state-root.test.mjs`

**Interfaces:**
- Consumes: `explicit?: string`, `environment?: Record<string,string|undefined>`, `home?: string`.
- Produces: `resolveControllerStateRoot(options): string`.

- [ ] **Step 1: Write failing precedence and fail-closed tests**

Cover explicit override, `GOAL_CONDITION_CODEX_STATE_ROOT`, absolute `XDG_STATE_HOME`, home fallback, empty/relative environment values, and invalid home input. Assert exact returned strings; assert invalid inputs return `STATE_ROOT_INVALID` rather than falling through.

```js
import * as controller from '../src/index.mjs';

const { resolveControllerStateRoot } = controller;
assert.equal(typeof resolveControllerStateRoot, 'function');
assert.equal(resolveControllerStateRoot({
  explicit: '/controller/explicit',
  environment: { GOAL_CONDITION_CODEX_STATE_ROOT: '/controller/env' },
  home: '/controller/home',
}), '/controller/explicit');
assert.equal(resolveControllerStateRoot({
  environment: { XDG_STATE_HOME: '/controller/xdg' },
  home: '/controller/home',
}), '/controller/xdg/goal-condition/codex-v2');
assert.throws(
  () => resolveControllerStateRoot({ environment: { XDG_STATE_HOME: 'relative' }, home: '/controller/home' }),
  (error) => error.code === 'STATE_ROOT_INVALID',
);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test goal-condition-template/codex-controller/tests/state-root.test.mjs`

Expected: FAIL because `../src/state-root.mjs` does not exist.

- [ ] **Step 3: Implement the resolver**

Use `Object.prototype.hasOwnProperty.call` to distinguish an unset variable from an explicitly empty one. Validate the selected base as a non-empty normalized absolute path with `resolve(value) === value`; join only the validated XDG or home base with `goal-condition/codex-v2`.

The public result shape is a path string. Errors use `error.code = 'STATE_ROOT_INVALID'` and never include the user-controlled value in the message.

```js
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function validAbsolute(value) {
  return typeof value === 'string' && value.length > 0
    && isAbsolute(value) && resolve(value) === value;
}

function requireAbsolute(value) {
  if (!validAbsolute(value)) {
    const error = new Error('controller state root must be a normalized absolute path');
    error.code = 'STATE_ROOT_INVALID';
    throw error;
  }
  return value;
}

export function resolveControllerStateRoot({
  explicit,
  environment = process.env,
  home = homedir(),
} = {}) {
  if (explicit !== undefined) return requireAbsolute(explicit);
  if (hasOwn(environment, 'GOAL_CONDITION_CODEX_STATE_ROOT')) {
    return requireAbsolute(environment.GOAL_CONDITION_CODEX_STATE_ROOT);
  }
  if (hasOwn(environment, 'XDG_STATE_HOME')) {
    return join(requireAbsolute(environment.XDG_STATE_HOME), 'goal-condition', 'codex-v2');
  }
  return join(requireAbsolute(home), '.local', 'state', 'goal-condition', 'codex-v2');
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test goal-condition-template/codex-controller/tests/state-root.test.mjs`

Expected: all resolver tests pass.

- [ ] **Step 5: Commit**

```bash
git add goal-condition-template/codex-controller/src/state-root.mjs \
  goal-condition-template/codex-controller/src/index.mjs \
  goal-condition-template/codex-controller/tests/state-root.test.mjs
git commit -m "feat(codex): resolve a canonical controller state root"
```

### Task 2: CLI Defaulting and Namespace Isolation

**Files:**
- Modify: `goal-condition-template/codex-controller/src/cli.mjs`
- Modify: `goal-condition-template/codex-controller/tests/cli.test.mjs`

**Interfaces:**
- Consumes: `resolveControllerStateRoot({ explicit: flags['state-root'] })` from Task 1.
- Produces: every command whose specification contains `state-root` receives a resolved `flags['state-root']` before its handler runs.

- [ ] **Step 1: Add failing CLI tests**

Extend the test helper to accept a controlled `env`. Add a test that runs `mode` without `--state-root` while `GOAL_CONDITION_CODEX_STATE_ROOT` points at a test directory, then runs `init`, `preview`, and `confirm` without the flag against the same store. Add an explicit-flag test proving it wins over the environment and observes a separate `disabled` namespace. Add a relative/empty environment test expecting `STATE_ROOT_INVALID` and no fallback state creation.

```js
function run(args, { env = process.env } = {}) {
  const child = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env,
  });
  return {
    ...child,
    stdoutJson: child.stdout.trim() === '' ? null : JSON.parse(child.stdout),
    stderrJson: child.stderr.trim() === '' ? null : JSON.parse(child.stderr),
  };
}

const controlledEnv = { ...process.env, GOAL_CONDITION_CODEX_STATE_ROOT: stateRoot };
const mode = run(['mode', '--input', getPath], { env: controlledEnv });
assert.equal(mode.stdoutJson.mode, 'disabled');
assert.equal(run([
  'mode', '--state-root', explicitRoot, '--input', getPath,
], { env: controlledEnv }).stdoutJson.mode, 'disabled');
```

- [ ] **Step 2: Run CLI tests and verify RED**

Run: `node --test goal-condition-template/codex-controller/tests/cli.test.mjs`

Expected: new no-flag cases fail with `CLI_FLAG_REQUIRED`.

- [ ] **Step 3: Resolve the path exactly once after parsing**

Import the resolver in `cli.mjs`. During `parseArgs`, allow a missing `state-root` only for commands whose closed specification already declares that flag. After required-field validation, replace `flags['state-root']` with `resolveControllerStateRoot({ explicit: flags['state-root'] })`. Do not change `capabilities`, which has no controller store.

```js
const defaultsStateRoot = specification.required.includes('state-root');
for (const name of specification.required) {
  if (!(name in flags) && !(name === 'state-root' && defaultsStateRoot)) {
    throw cliError('CLI_FLAG_REQUIRED');
  }
}
if (defaultsStateRoot) {
  flags['state-root'] = resolveControllerStateRoot({ explicit: flags['state-root'] });
}
```

- [ ] **Step 4: Run CLI and controller tests**

Run:

```bash
node --test goal-condition-template/codex-controller/tests/cli.test.mjs
node --test goal-condition-template/codex-controller/tests/*.test.mjs
```

Expected: all tests pass; explicit namespaces preserve their own rollout state.

- [ ] **Step 5: Commit**

```bash
git add goal-condition-template/codex-controller/src/cli.mjs \
  goal-condition-template/codex-controller/tests/cli.test.mjs
git commit -m "feat(codex): default stateful commands to the canonical store"
```

### Task 3: Release Inventory, Protocol, and ADR

**Files:**
- Modify: `goal-condition-template/scripts/lib/installer.mjs`
- Modify: `goal-condition-template/SKILL.md`
- Modify: `goal-condition-template/references/codex-goal-session-v2.md`
- Modify: `goal-condition-template/references/adapters/codex.md`
- Modify: `goal-condition-template/tests/static.test.mjs`
- Create: `docs/decisions/2026-08-12-codex-canonical-state-root.md`

**Interfaces:**
- Consumes: installed controller file `codex-controller/src/state-root.mjs` and the CLI behavior from Task 2.
- Produces: an immutable release containing the resolver and public Codex guidance naming the default and override semantics.

- [ ] **Step 1: Write failing release/static tests**

Require `state-root.mjs` in `REQUIRED_CORE_FILES`. Require the Skill and operation protocol to state that ordinary commands may omit `--state-root`, name the canonical default, and define explicit overrides as independently gated namespaces. Assert Claude adapter and shared schema diffs remain empty.

```js
assert.ok(REQUIRED_CORE_FILES.includes('codex-controller/src/state-root.mjs'));
assert.match(skill, /\.local\/state\/goal-condition\/codex-v2/);
assert.match(protocol, /GOAL_CONDITION_CODEX_STATE_ROOT/);
assert.match(protocol, /独立.*rollout|rollout.*独立/);
```

- [ ] **Step 2: Run focused static/install tests and verify RED**

Run:

```bash
node --test goal-condition-template/tests/static.test.mjs
node --test goal-condition-template/tests/install.test.mjs
```

Expected: static inventory/guidance assertions fail before production files change.

- [ ] **Step 3: Update production docs, inventory, and ADR**

Add `codex-controller/src/state-root.mjs` to `REQUIRED_CORE_FILES`. Keep `SKILL.md` below 200 lines. Document the four-level precedence, fail-closed invalid override, shared normal store, and independent rollout for alternative stores. Record the adopted decision and rejected documentation-only alternatives in the ADR.

```js
export const REQUIRED_CORE_FILES = Object.freeze([
  // existing entries remain byte-for-byte ordered
  'codex-controller/src/state-root.mjs',
]);
```

- [ ] **Step 4: Run focused and full deterministic gates**

Run:

```bash
node --test goal-condition-template/tests/static.test.mjs
node --test goal-condition-template/tests/install.test.mjs
node --test goal-condition-template/tests/*.test.mjs
node --test goal-condition-template/codex-controller/tests/*.test.mjs
```

Expected: root 342+ tests and controller 137+ tests pass with zero failures.

- [ ] **Step 5: Verify scope and commit**

Run:

```bash
git diff --exit-code origin/main -- goal-condition-template/scripts/lib/adapters/claude.mjs \
  goal-condition-template/references/adapters/claude.md \
  goal-condition-template/schema/run-contract.schema.json \
  goal-condition-template/scripts/lib/workflow.mjs
git diff --check
```

Then commit:

```bash
git add goal-condition-template docs/decisions/2026-08-12-codex-canonical-state-root.md
git commit -m "docs(codex): make the canonical state store operational"
```

### Task 4: Publish, Install, and Re-Certify

**Files:**
- No source edits unless review finds an actionable defect.
- Runtime evidence: canonical controller store resolved by the installed CLI.

**Interfaces:**
- Consumes: merged commit, installer manifest digest, installed Codex link, confirmed authorization hash `89c5919393ecad68419651d056538dad523248ad97ae384966ec587c42d3c362`.
- Produces: merged PR, immutable installed release, canonical store in `enabled`, controller-certified dynamic-revision canary receipt.

- [ ] **Step 1: Push and open a ready PR**

Include root cause, minimal versus adopted solution, scope boundary, and exact test results. Wait a bounded window for Cursor Bugbot and read all available comments/checks.

- [ ] **Step 2: Address actionable review and merge**

Use TDD for any code correction. Merge directly only when current diff and checks are acceptable, then fetch the exact merge commit.

- [ ] **Step 3: Install only the Codex link and verify manifest**

Record Claude and Codex links before/after. Install from the merge commit with the existing private profile source. Verify with the externally retained manifest digest. Do not touch Claude.

- [ ] **Step 4: Run the canonical-store promotion canary**

Call the installed CLI without `--state-root` under the normal environment. Verify it chooses `<home>/.local/state/goal-condition/codex-v2`. Run the approved read-only, network-denied promotion shape: Candidate 1, `ADD_AND_VERIFIER`, Rejected Attempt 1, new immutable Attempt 2, two controller-owned passing Evidence records, Certified finalize, quiescent close, and `canary -> enabled`.

- [ ] **Step 5: Final readback**

Verify: PR merged; manifest has no drift; Codex link points at the merge commit; Claude link is unchanged; `adopt`/`shadow` are unknown; installed mode is `enabled` and bound to the new release/canary; terminal event is `GOAL_SESSION_CERTIFIED`; bypasses and lease files are empty; marker hash is unchanged; full test suites remain green.
