import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { commandNames } from '../src/cli.mjs';
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

test('Plan 1 CLI exposes no live execution command', () => {
  assert.deepEqual(commandNames().sort(), [
    'confirm',
    'evaluate',
    'export',
    'init',
    'project',
    'revise',
    'shadow',
    'status',
  ]);
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
    controller_facts: {},
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
    controller_facts: {},
  });
  const result = run([
    'revise', '--state-root', stateRoot, '--session-id', draft.session_id, '--input', revision,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdoutJson.decision, 'reauthorize');
  assert.equal(result.stdoutJson.status, 'AwaitingReauthorization');
});

test('shadow never mutates a legacy state directory', async () => {
  const { root } = await workspace();
  const legacy = join(root, 'legacy-state');
  await writeFile(legacy, 'legacy bytes', { mode: 0o600 });
  const validContract = JSON.parse(
    await readFile(new URL('../../tests/fixtures/valid-contract.json', import.meta.url), 'utf8'),
  );
  const input = {
    legacy_contract: validContract,
    current_contract: structuredClone(validContract),
    candidate: { terminal_reason: 'completed' },
    postflight: { ok: false },
    observations: { typed_operation: { type: 'ADD_CONDITION' } },
    legacy_state_path: legacy,
  };
  const before = createHash('sha256').update(await readFile(legacy)).digest('hex');
  const result = run(['shadow', '--input', await writeJson(root, 'shadow.json', input)]);
  const after = createHash('sha256').update(await readFile(legacy)).digest('hex');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdoutJson.live_execution, false);
  assert.equal(before, after);
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
});
