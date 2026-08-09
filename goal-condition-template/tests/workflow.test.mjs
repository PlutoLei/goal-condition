import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { nextAction, runtimeTerminalState } from '../scripts/lib/workflow.mjs';

const pressureCasesUrl = new URL('./fixtures/pressure-cases.json', import.meta.url);
const pressureCases = JSON.parse(await readFile(pressureCasesUrl, 'utf8'));

const contractHash = 'a'.repeat(64);
const baselineDigest = 'b'.repeat(64);
const confirmed = Object.freeze({ validation: [], contractHash, confirmedHash: contractHash });
const runBinding = Object.freeze({ contractHash, baselineDigest, runId: 'run-a' });
const successfulPreflight = Object.freeze({ ok: true, reasons: [], binding: runBinding });
const successfulPostflight = Object.freeze({ ok: true, reasons: [], binding: runBinding });
const successfulClaude = Object.freeze({
  subtype: 'success',
  is_error: false,
  terminal_reason: 'completed',
  permission_denials: [],
});
const readyCodex = Object.freeze({ status: 'ready_for_postflight', remaining_work: false });
const successfulFinalization = Object.freeze({
  ok: true,
  operation: 'thread/goal/set',
  status: 'complete',
  reasons: [],
  binding: runBinding,
});
const successfulReadback = Object.freeze({
  ok: true,
  source: 'thread/goal/get',
  status: 'complete',
  remaining_work: false,
  error: false,
  blocked: false,
  reasons: [],
  binding: runBinding,
});

function controllerInput(runtime, runtimeResult, overrides = {}) {
  return {
    ...confirmed,
    runtime,
    runBinding,
    preflightEvidence: successfulPreflight,
    runtimeResult,
    ...overrides,
  };
}

function codexInput(overrides = {}) {
  return controllerInput('codex', readyCodex, overrides);
}

function claudeInput(overrides = {}) {
  return controllerInput('claude', successfulClaude, overrides);
}

test('requires validation and the exact confirmation hash before controller preflight', () => {
  assert.equal(nextAction({ validation: [], contractHash, confirmedHash: 'c'.repeat(64) }).action, 'preview');
  assert.equal(nextAction(confirmed).action, 'preflight');
  assert.equal(nextAction({ ...confirmed, validation: ['objective selection required'] }).action, 'reject');
});

test('launch requires closed-world controller-owned preflight evidence bound to one run', () => {
  assert.equal(nextAction({
    ...confirmed,
    runtime: 'claude',
    runBinding,
    preflightEvidence: successfulPreflight,
  }).action, 'launch');

  for (const preflightEvidence of [
    { ok: true, reasons: [] },
    { ...successfulPreflight, surprise: true },
    { ...successfulPreflight, ok: 'yes' },
    { ...successfulPreflight, ok: false, reasons: [] },
    { ...successfulPreflight, binding: { ...runBinding, runId: 'other-run' } },
  ]) {
    assert.equal(nextAction({
      ...confirmed, runtime: 'claude', runBinding, preflightEvidence,
    }).action, 'reject');
  }
});

test('legacy self-certified gates are rejected instead of being treated as controller evidence', () => {
  assert.equal(nextAction({ ...confirmed, runtime: 'claude', preflight: { ok: true } }).action, 'reject');
  assert.equal(nextAction(claudeInput({ postflight: { ok: true } })).action, 'reject');
});

test('pressure state fixtures cannot bypass the fail-closed transition order', () => {
  for (const pressureCase of pressureCases) {
    assert.equal(nextAction(pressureCase.input).action, pressureCase.expected_action, pressureCase.name);
    assert.ok(pressureCase.forbidden_claims.length > 0, pressureCase.name);
  }
});

test('Claude runtime evidence is exact closed-world terminal evidence', () => {
  assert.deepEqual(runtimeTerminalState('claude', successfulClaude), { ok: true, reasons: [] });
  for (const runtimeResult of [
    null,
    { ...successfulClaude, is_error: true },
    { ...successfulClaude, terminal_reason: 'api_error' },
    { ...successfulClaude, permission_denials: ['denied'] },
    { ...successfulClaude, controller_postflight: true },
    { subtype: 'success', is_error: false, terminal_reason: 'completed' },
  ]) {
    assert.equal(runtimeTerminalState('claude', runtimeResult).ok, false);
    assert.equal(nextAction(claudeInput({ runtimeResult })).action, 'reject');
  }
});

test('Codex runtime result remains an exact untrusted candidate', () => {
  assert.deepEqual(runtimeTerminalState('codex', readyCodex), {
    ok: true, phase: 'ready_for_postflight', reasons: [],
  });
  for (const runtimeResult of [
    null,
    { ...readyCodex, remaining_work: true },
    { status: 'complete', remaining_work: false },
    { ...readyCodex, postflightEvidence: successfulPostflight },
    { ...readyCodex, readback: 'get_goal' },
  ]) {
    assert.equal(runtimeTerminalState('codex', runtimeResult).ok, false);
    assert.equal(nextAction(codexInput({ runtimeResult })).action, 'reject');
  }
});

test('Claude completes only with bound controller-owned postflight evidence', () => {
  assert.equal(nextAction(claudeInput()).action, 'postflight');
  assert.deepEqual(nextAction(claudeInput({ postflightEvidence: successfulPostflight })), {
    action: 'complete', reasons: [],
  });
  for (const postflightEvidence of [
    null,
    { ok: true, reasons: [], binding: { ...runBinding, baselineDigest: 'd'.repeat(64) } },
    { ...successfulPostflight, ok: false, reasons: ['artifact missing'] },
    { ...successfulPostflight, surprise: true },
  ]) {
    assert.equal(nextAction(claudeInput({ postflightEvidence })).action, 'reject');
  }
});

test('Codex preserves postflight then finalization then independent readback order', () => {
  assert.equal(nextAction(codexInput()).action, 'postflight');
  assert.equal(nextAction(codexInput({ postflightEvidence: successfulPostflight })).action, 'finalize_runtime');
  assert.equal(nextAction(codexInput({
    postflightEvidence: successfulPostflight,
    finalizationReceipt: successfulFinalization,
  })).action, 'verify_runtime');
  assert.deepEqual(nextAction(codexInput({
    postflightEvidence: successfulPostflight,
    finalizationReceipt: successfulFinalization,
    runtimeReadback: successfulReadback,
  })), { action: 'complete', reasons: [] });
});

test('Codex rejects direct jumps and execution-session self-certification', () => {
  assert.equal(nextAction({
    ...confirmed,
    runtime: 'codex',
    runBinding,
    preflightEvidence: successfulPreflight,
    postflightEvidence: successfulPostflight,
    finalizationReceipt: successfulFinalization,
    runtimeReadback: successfulReadback,
  }).action, 'reject');
  assert.equal(nextAction(codexInput({ finalizationReceipt: successfulFinalization })).action, 'reject');
  assert.equal(nextAction(codexInput({ runtimeReadback: successfulReadback })).action, 'reject');
  assert.equal(nextAction(codexInput({
    postflightEvidence: successfulPostflight,
    runtimeReadback: successfulReadback,
  })).action, 'reject');
});

test('every controller-owned channel uses the same contract baseline and run binding', () => {
  const changedBindings = [
    { ...runBinding, contractHash: 'c'.repeat(64) },
    { ...runBinding, baselineDigest: 'd'.repeat(64) },
    { ...runBinding, runId: 'other-run' },
  ];
  for (const binding of changedBindings) {
    assert.equal(nextAction(codexInput({ runBinding: binding })).action, 'reject');
    assert.equal(nextAction(codexInput({
      postflightEvidence: { ...successfulPostflight, binding },
    })).action, 'reject');
    assert.equal(nextAction(codexInput({
      postflightEvidence: successfulPostflight,
      finalizationReceipt: { ...successfulFinalization, binding },
    })).action, 'reject');
    assert.equal(nextAction(codexInput({
      postflightEvidence: successfulPostflight,
      finalizationReceipt: successfulFinalization,
      runtimeReadback: { ...successfulReadback, binding },
    })).action, 'reject');
  }
});

test('controller evidence fails closed on malformed, failed, or unknown fields', () => {
  for (const postflightEvidence of [
    { ...successfulPostflight, ok: false, reasons: ['unexpected commit'] },
    { ...successfulPostflight, reasons: 'not an array' },
    { ...successfulPostflight, surprise: true },
  ]) {
    assert.equal(nextAction(codexInput({ postflightEvidence })).action, 'reject');
  }
  for (const finalizationReceipt of [
    { ...successfulFinalization, ok: false, reasons: ['update failed'] },
    { ...successfulFinalization, operation: 'update_goal' },
    { ...successfulFinalization, operation: 'runtimeResult' },
    { ...successfulFinalization, status: 'in_progress' },
    { ...successfulFinalization, surprise: true },
  ]) {
    assert.equal(nextAction(codexInput({
      postflightEvidence: successfulPostflight, finalizationReceipt,
    })).action, 'reject');
  }
  for (const runtimeReadback of [
    { ...successfulReadback, ok: false, reasons: ['get_goal failed'] },
    { ...successfulReadback, source: 'get_goal' },
    { ...successfulReadback, error: true },
    { ...successfulReadback, blocked: true },
    { ...successfulReadback, remaining_work: true },
    { ...successfulReadback, source: 'runtimeResult' },
    { ...successfulReadback, status: 'in_progress' },
    { ...successfulReadback, permission_denials: ['denied'] },
  ]) {
    assert.equal(nextAction(codexInput({
      postflightEvidence: successfulPostflight,
      finalizationReceipt: successfulFinalization,
      runtimeReadback,
    })).action, 'reject');
  }
});
