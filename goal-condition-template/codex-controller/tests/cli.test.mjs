import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { commandNames } from '../src/cli.mjs';
import { stateDirFor } from '../../scripts/launch.mjs';
import { validDraft } from './helpers.mjs';

const cliPath = new URL('../src/cli.mjs', import.meta.url).pathname;
const roots = [];

async function workspace() {
  const root = await mkdtemp(join(process.cwd(), '.gc-cli-test-'));
  roots.push(root);
  return { root, stateRoot: join(root, 'state') };
}

async function writeJson(root, name, value) {
  const path = join(root, name);
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return path;
}

function run(args) {
  const child = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
  return {
    ...child,
    stdoutJson: child.stdout.trim() === '' ? null : JSON.parse(child.stdout),
    stderrJson: child.stderr.trim() === '' ? null : JSON.parse(child.stderr),
  };
}

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('controlled CLI exposes the closed GoalSession lifecycle', () => {
  assert.deepEqual(commandNames().sort(), [
    'capabilities',
    'close',
    'confirm',
    'evaluate',
    'export',
    'finalize',
    'init',
    'launch',
    'migrate-v1',
    'mode',
    'prepare',
    'preview',
    'project',
    'reconcile',
    'resume',
    'revise',
    'status',
    'verify',
  ]);
  for (const retired of ['adopt', 'shadow']) {
    const result = run([retired]);
    assert.notEqual(result.status, 0);
    assert.equal(result.stderrJson.code, 'CLI_COMMAND_UNKNOWN');
  }
});

test('controlled CLI executes through the installed release symlink', async () => {
  const { root } = await workspace();
  const linkedRoot = join(root, 'goal-condition');
  const releaseRoot = dirname(dirname(dirname(cliPath)));
  await symlink(releaseRoot, linkedRoot, 'dir');
  const linkedCli = join(linkedRoot, 'codex-controller', 'src', 'cli.mjs');
  const child = spawnSync(process.execPath, [linkedCli], { encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  assert.deepEqual(JSON.parse(child.stderr), { ok: false, code: 'CLI_COMMAND_UNKNOWN' });
});

test('init can capture a controller-owned root baseline and prepare a durable Attempt', async () => {
  const { root, stateRoot } = await workspace();
  const target = join(root, 'target');
  await mkdir(target);
  const draft = validDraft();
  draft.authority.target_roots = [target];
  draft.authority.hard_prohibitions = [];
  draft.initial_design.active_boundary.target_roots = [target];
  draft.initial_design.conditions[0].verifier.cwd = target;
  draft.initial_design.conditions[0].verifier.argv = [process.execPath, '--version'];
  const initialized = run([
    'init', '--state-root', stateRoot, '--input', await writeJson(root, 'draft.json', draft),
    '--capture-baseline', 'true',
  ]);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(initialized.stdoutJson.root_baseline_digest.length, 64);
  const previewed = run([
    'preview', '--state-root', stateRoot, '--session-id', draft.session_id,
  ]);
  assert.equal(previewed.status, 0, previewed.stderr);
  assert.match(previewed.stdoutJson.markdown, /# GoalSession Authorization/);
  assert.equal(previewed.stdoutJson.authorization_hash, initialized.stdoutJson.authorization_hash);
  const confirmation = await writeJson(root, 'confirmation.json', {
    authorization_hash: initialized.stdoutJson.authorization_hash,
    thread_id: 'thread-cli', message_ref: 'message-confirmed', source: 'codex-task',
    confirmed_at: '2026-08-11T00:00:00.000Z',
  });
  assert.equal(run([
    'confirm', '--state-root', stateRoot, '--session-id', draft.session_id, '--input', confirmation,
  ]).status, 0);
  assert.equal(run(['mode', '--state-root', stateRoot, '--input', await writeJson(root, 'mode.json', {
    action: 'set', next: 'canary', changed_at: '2026-08-11T00:00:00.000Z', canary_session_id: null,
  })]).status, 0);
  const prepared = run([
    'prepare', '--state-root', stateRoot, '--session-id', draft.session_id,
    '--input', await writeJson(root, 'prepare.json', {
      attempt_id: 'attempt-cli-live',
      run_id: 'run-cli-live',
      nonce: '00112233445566778899aabbccddeeff',
      expires_at: '2099-08-11T00:00:00.000Z',
      hard_prohibition_capabilities: [],
    }),
  ]);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(prepared.stdoutJson.live_execution, false);
  assert.equal(prepared.stdoutJson.attempt_hash.length, 64);
  const closed = run([
    'close', '--state-root', stateRoot, '--session-id', draft.session_id,
    '--run-id', 'run-cli-live', '--runtime-root', join(root, 'runtime'),
  ]);
  assert.equal(closed.status, 0, closed.stderr);
  assert.equal(closed.stdoutJson.root_lease_released, true);
  await writeFile(join(target, 'run-product.txt'), 'allowed controller product\n');
  const preparedAgain = run([
    'prepare', '--state-root', stateRoot, '--session-id', draft.session_id,
    '--input', await writeJson(root, 'prepare-again.json', {
      attempt_id: 'attempt-cli-live-2',
      run_id: 'run-cli-live-2',
      nonce: 'ffeeddccbbaa99887766554433221100',
      expires_at: '2099-08-11T00:00:00.000Z',
      hard_prohibition_capabilities: [],
    }),
  ]);
  assert.equal(preparedAgain.status, 0, preparedAgain.stderr);
});

test('read-only Authority rejects target mutations before prepare', async () => {
  const { root, stateRoot } = await workspace();
  const target = join(root, 'target');
  await mkdir(target);
  await writeFile(join(target, 'baseline.txt'), 'trusted baseline\n');
  const draft = validDraft();
  draft.authority.target_roots = [target];
  draft.authority.actions = ['read', 'execute'];
  draft.authority.hard_prohibitions = [];
  draft.initial_design.active_boundary.target_roots = [target];
  draft.initial_design.active_boundary.actions = ['read', 'execute'];
  draft.initial_design.conditions[0].verifier.cwd = target;
  draft.initial_design.conditions[0].verifier.argv = ['/bin/test', '-f', join(target, 'baseline.txt')];
  const initialized = run([
    'init', '--state-root', stateRoot, '--input', await writeJson(root, 'read-only-draft.json', draft),
    '--capture-baseline', 'true',
  ]).stdoutJson;
  const confirmation = await writeJson(root, 'read-only-confirmation.json', {
    authorization_hash: initialized.authorization_hash,
    thread_id: 'thread-read-only', message_ref: 'message-confirmed', source: 'codex-task',
  });
  assert.equal(run([
    'confirm', '--state-root', stateRoot, '--session-id', draft.session_id, '--input', confirmation,
  ]).status, 0);
  assert.equal(run(['mode', '--state-root', stateRoot, '--input', await writeJson(root, 'read-only-mode.json', {
    action: 'set', next: 'canary', changed_at: '2026-08-11T00:00:00.000Z', canary_session_id: null,
  })]).status, 0);

  await writeFile(join(target, 'unauthorized.txt'), 'must be detected\n');
  const prepared = run([
    'prepare', '--state-root', stateRoot, '--session-id', draft.session_id,
    '--input', await writeJson(root, 'read-only-prepare.json', {
      attempt_id: 'attempt-read-only', run_id: 'run-read-only',
      nonce: '00112233445566778899aabbccddeeff', expires_at: '2099-08-11T00:00:00.000Z',
      hard_prohibition_capabilities: [],
    }),
  ]);
  assert.notEqual(prepared.status, 0);
  assert.equal(prepared.stderrJson.code, 'WORKSPACE_BOUNDARY_VIOLATION');
});

test('mode and capability commands are closed-world and controller-only', async () => {
  const { root, stateRoot } = await workspace();
  const capabilities = run(['capabilities', '--input', await writeJson(root, 'caps.json', {
    probes: {
      sandbox: {
        type: 'workspaceWrite', writableRoots: [], networkAccess: false,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false,
      },
      controller_state_outside_targets: true,
      thread_read: true,
      turn_readback: true,
    },
    hard_prohibitions: [{ id: 'network', capability: 'network-deny' }],
  })]);
  assert.equal(capabilities.status, 0, capabilities.stderr);
  assert.equal(capabilities.stdoutJson.launchable, true);
  const get = await writeJson(root, 'mode-get.json', {
    action: 'get', next: null, changed_at: null, canary_session_id: null,
  });
  const initialMode = run(['mode', '--state-root', stateRoot, '--input', get]).stdoutJson;
  assert.equal(initialMode.mode, 'disabled');
  assert.match(initialMode.release_manifest_digest, /^[0-9a-f]{64}$/);
  const set = await writeJson(root, 'mode-set.json', {
    action: 'set', next: 'canary', changed_at: '2026-08-11T00:00:00.000Z', canary_session_id: null,
  });
  assert.equal(run(['mode', '--state-root', stateRoot, '--input', set]).stdoutJson.mode, 'canary');
  const enabledWithoutCanary = await writeJson(root, 'mode-enabled-no-canary.json', {
    action: 'set', next: 'enabled', changed_at: '2026-08-11T00:01:00.000Z', canary_session_id: null,
  });
  const rejected = run(['mode', '--state-root', stateRoot, '--input', enabledWithoutCanary]);
  assert.notEqual(rejected.status, 0);
  assert.equal(rejected.stderrJson.code, 'ROLLOUT_CANARY_REQUIRED');
});

test('close preserves the controller lease when a foreign live runtime lease prevents quiescence', async () => {
  const { root, stateRoot } = await workspace();
  const target = join(root, 'target');
  const runtimeRoot = join(root, 'runtime');
  await mkdir(target);
  const draft = validDraft();
  draft.authority.target_roots = [target];
  draft.authority.hard_prohibitions = [];
  draft.initial_design.active_boundary.target_roots = [target];
  draft.initial_design.conditions[0].verifier.cwd = target;
  draft.initial_design.conditions[0].verifier.argv = ['/bin/test', '-d', target];
  const initialized = run([
    'init', '--state-root', stateRoot, '--input', await writeJson(root, 'close-draft.json', draft),
    '--capture-baseline', 'true',
  ]).stdoutJson;
  const confirmation = await writeJson(root, 'close-confirmation.json', {
    authorization_hash: initialized.authorization_hash,
    thread_id: 'thread-cli', message_ref: 'message-confirmed', source: 'codex-task',
  });
  assert.equal(run([
    'confirm', '--state-root', stateRoot, '--session-id', draft.session_id, '--input', confirmation,
  ]).status, 0);
  assert.equal(run(['mode', '--state-root', stateRoot, '--input', await writeJson(root, 'close-mode.json', {
    action: 'set', next: 'canary', changed_at: '2026-08-11T00:00:00.000Z', canary_session_id: null,
  })]).status, 0);
  const prepared = run([
    'prepare', '--state-root', stateRoot, '--session-id', draft.session_id,
    '--input', await writeJson(root, 'close-prepare.json', {
      attempt_id: 'attempt-close-failure', run_id: 'run-close-failure',
      nonce: '00112233445566778899aabbccddeeff', expires_at: '2099-08-11T00:00:00.000Z',
      hard_prohibition_capabilities: [],
    }),
  ]).stdoutJson;
  const runtimeState = stateDirFor({
    stateRoot: runtimeRoot,
    controller: `goal-session-v2-${draft.session_id}-attempt-close-failure`,
    contractHash: prepared.contract_hash,
  });
  await mkdir(runtimeState, { recursive: true });
  await writeFile(join(runtimeState, 'lease.json'), JSON.stringify({
    pid: process.pid,
    startedAt: Date.now() - 1000,
    heartbeatAt: Date.now(),
  }));

  const closed = run([
    'close', '--state-root', stateRoot, '--session-id', draft.session_id,
    '--run-id', 'run-close-failure', '--runtime-root', runtimeRoot,
  ]);
  assert.equal(closed.status, 0, closed.stderr);
  assert.equal(closed.stdoutJson.ok, false);
  assert.equal(closed.stdoutJson.status, 'ReconciliationRequired');
  assert.equal(closed.stdoutJson.root_lease_released, false);
  assert.equal(closed.stdoutJson.result.cleanupComplete, false);
  assert.equal(closed.stdoutJson.result.runtimeQuiesced, false);
  const exported = run(['export', '--state-root', stateRoot, '--session-id', draft.session_id]);
  assert.equal(exported.stdoutJson.export.session.status, 'ReconciliationRequired');
});

test('prepare rejects a caller-selected capability mapping for a different hard prohibition', async () => {
  const { root, stateRoot } = await workspace();
  const target = join(root, 'target');
  await mkdir(target);
  const draft = validDraft();
  draft.authority.target_roots = [target];
  draft.initial_design.active_boundary.target_roots = [target];
  draft.initial_design.conditions[0].verifier.cwd = target;
  const initialized = run([
    'init', '--state-root', stateRoot, '--input', await writeJson(root, 'draft.json', draft),
    '--capture-baseline', 'true',
  ]).stdoutJson;
  const confirmation = await writeJson(root, 'confirmation.json', {
    authorization_hash: initialized.authorization_hash,
    thread_id: 'thread-cli', message_ref: 'message-confirmed', source: 'codex-task',
  });
  assert.equal(run([
    'confirm', '--state-root', stateRoot, '--session-id', draft.session_id, '--input', confirmation,
  ]).status, 0);
  assert.equal(run(['mode', '--state-root', stateRoot, '--input', await writeJson(root, 'mode.json', {
    action: 'set', next: 'canary', changed_at: '2026-08-11T00:00:00.000Z', canary_session_id: null,
  })]).status, 0);
  const prepared = run([
    'prepare', '--state-root', stateRoot, '--session-id', draft.session_id,
    '--input', await writeJson(root, 'prepare.json', {
      attempt_id: 'attempt-mapping', run_id: 'run-mapping',
      nonce: '00112233445566778899aabbccddeeff', expires_at: '2099-08-11T00:00:00.000Z',
      hard_prohibition_capabilities: [{ rule: 'network-deny', capability: 'workspace-write-boundary' }],
    }),
  ]);
  assert.notEqual(prepared.status, 0);
  assert.equal(prepared.stderrJson.code, 'HARD_PROHIBITION_CAPABILITY_MISMATCH');
});

test('init, confirm, revise, project, evaluate, status, and export stay controller-only', async () => {
  const { root, stateRoot } = await workspace();
  const draft = validDraft();
  draft.authority.secret_refs = ['secret-ref-prod-api'];
  const draftPath = await writeJson(root, 'draft.json', draft);
  const initialized = run(['init', '--state-root', stateRoot, '--input', draftPath]);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(initialized.stdoutJson.status, 'AwaitingConfirmation');
  assert.equal(initialized.stdoutJson.live_execution, false);

  const confirmationPath = await writeJson(root, 'confirmation.json', {
    authorization_hash: initialized.stdoutJson.authorization_hash,
    thread_id: 'thread-cli',
    message_ref: 'message-confirmed',
    source: 'codex-task',
    confirmed_at: '2026-08-11T00:00:00.000Z',
  });
  const confirmed = run([
    'confirm',
    '--state-root', stateRoot,
    '--session-id', draft.session_id,
    '--input', confirmationPath,
  ]);
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.equal(confirmed.stdoutJson.status, 'Ready');

  const condition = structuredClone(draft.initial_design.conditions[0]);
  condition.id = 'condition-regression';
  condition.verifier.id = 'verify-regression';
  condition.projection.criterion_id = 'success-regression';
  const revisionPath = await writeJson(root, 'revision.json', {
    operation: {
      version: 1,
      type: 'ADD_CONDITION',
      reason: 'shadow regression coverage',
      evidence_refs: [],
      payload: { condition },
    },
  });
  const revised = run([
    'revise',
    '--state-root', stateRoot,
    '--session-id', draft.session_id,
    '--input', revisionPath,
  ]);
  assert.equal(revised.status, 0, revised.stderr);
  assert.equal(revised.stdoutJson.decision, 'auto_apply');
  assert.equal(revised.stdoutJson.reauthorization_required, false);

  const projected = run([
    'project',
    '--state-root', stateRoot,
    '--session-id', draft.session_id,
    '--attempt-id', 'attempt-cli-1',
  ]);
  assert.equal(projected.status, 0, projected.stderr);
  assert.equal(projected.stdoutJson.live_execution, false);
  assert.equal(projected.stdoutJson.manifest.runtime, 'codex');

  const evaluationPath = await writeJson(root, 'evaluation.json', {
    evidence: [],
    bypasses: [],
    current_inputs_by_condition: {},
    now: '2026-08-11T00:01:00.000Z',
  });
  const evaluated = run([
    'evaluate',
    '--state-root', stateRoot,
    '--session-id', draft.session_id,
    '--input', evaluationPath,
  ]);
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.equal(evaluated.stdoutJson.level, 'candidate');

  const statusA = run(['status', '--state-root', stateRoot, '--session-id', draft.session_id]);
  const statusB = run(['status', '--state-root', stateRoot, '--session-id', draft.session_id]);
  assert.deepEqual(statusA.stdoutJson, statusB.stdoutJson);
  assert.equal(JSON.stringify(statusA.stdoutJson).includes('secret-ref-prod-api'), false);

  const exportA = run(['export', '--state-root', stateRoot, '--session-id', draft.session_id]);
  const exportB = run(['export', '--state-root', stateRoot, '--session-id', draft.session_id]);
  assert.deepEqual(exportA.stdoutJson, exportB.stdoutJson);
  assert.equal(JSON.stringify(exportA.stdoutJson).includes('secret-ref-prod-api'), true);
  assert.equal(JSON.stringify(exportA.stdoutJson).includes('secret_value'), false);
});

test('EXPAND_AUTHORITY moves the session to AwaitingReauthorization', async () => {
  const { root, stateRoot } = await workspace();
  const draft = validDraft();
  const initialized = run([
    'init',
    '--state-root', stateRoot,
    '--input', await writeJson(root, 'draft.json', draft),
  ]).stdoutJson;
  const confirmation = await writeJson(root, 'confirmation.json', {
    authorization_hash: initialized.authorization_hash,
    thread_id: 'thread-cli',
    message_ref: 'message-confirmed',
    source: 'codex-task',
  });
  assert.equal(run([
    'confirm', '--state-root', stateRoot, '--session-id', draft.session_id, '--input', confirmation,
  ]).status, 0);

  const authority = structuredClone(draft.authority);
  authority.target_roots.push('/work/another-project');
  const revision = await writeJson(root, 'expand.json', {
    operation: {
      version: 1,
      type: 'EXPAND_AUTHORITY',
      reason: 'needs another root',
      evidence_refs: [],
      payload: { authority },
    },
  });
  const result = run([
    'revise', '--state-root', stateRoot, '--session-id', draft.session_id, '--input', revision,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdoutJson.decision, 'reauthorize');
  assert.equal(result.stdoutJson.status, 'AwaitingReauthorization');
  assert.notEqual(result.stdoutJson.authorization_hash, initialized.authorization_hash);
  const oldConfirmation = run([
    'confirm', '--state-root', stateRoot, '--session-id', draft.session_id,
    '--input', confirmation,
  ]);
  assert.notEqual(oldConfirmation.status, 0);
  assert.equal(oldConfirmation.stderrJson.code, 'AUTHORIZATION_HASH_MISMATCH');
  const newConfirmation = await writeJson(root, 'confirmation-new.json', {
    authorization_hash: result.stdoutJson.authorization_hash,
    thread_id: 'thread-cli', message_ref: 'message-confirmed-new', source: 'codex-task',
  });
  const confirmed = run([
    'confirm', '--state-root', stateRoot, '--session-id', draft.session_id, '--input', newConfirmation,
  ]);
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.equal(confirmed.stdoutJson.status, 'Ready');
});

test('unknown flags and unknown JSON fields fail closed without echoing values', async () => {
  const { root, stateRoot } = await workspace();
  const badFlag = run(['status', '--state-root', stateRoot, '--session-id', 'session-0001', '--bad', 'private-value']);
  assert.notEqual(badFlag.status, 0);
  assert.equal(badFlag.stdout, '');
  assert.equal(badFlag.stderr.includes('private-value'), false);
  assert.equal(badFlag.stderrJson.code, 'CLI_FLAG_UNKNOWN');

  const input = { ...validDraft(), unknown_private_field: 'private-value' };
  const badJson = run([
    'init', '--state-root', stateRoot, '--input', await writeJson(root, 'bad.json', input),
  ]);
  assert.notEqual(badJson.status, 0);
  assert.equal(badJson.stderr.includes('private-value'), false);
  assert.equal(badJson.stderrJson.code, 'UNKNOWN_FIELD');

  const forgedFacts = run([
    'revise', '--state-root', stateRoot, '--session-id', 'session-0001',
    '--input', await writeJson(root, 'forged-facts.json', {
      operation: { version: 1, type: 'UNCLASSIFIED', reason: 'x', evidence_refs: [], payload: {} },
      controller_facts: { context_hash_verified: true },
    }),
  ]);
  assert.notEqual(forgedFacts.status, 0);
  assert.equal(forgedFacts.stderrJson.code, 'UNKNOWN_FIELD');
});
