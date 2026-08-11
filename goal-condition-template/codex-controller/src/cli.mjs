import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { compileDraft, recordConfirmation } from './compiler.mjs';
import { transitionSession } from './domain.mjs';
import { completionLevel } from './evidence.mjs';
import { evaluateRevision } from './policy.mjs';
import { projectAttempt } from './projector.mjs';
import { classifyShadowReplay } from './shadow.mjs';
import { openSessionStore } from './store.mjs';
import { exactFields } from './values.mjs';

const COMMANDS = Object.freeze({
  init: { required: ['state-root', 'input'], optional: [] },
  confirm: { required: ['state-root', 'session-id', 'input'], optional: [] },
  revise: { required: ['state-root', 'session-id', 'input'], optional: [] },
  project: { required: ['state-root', 'session-id', 'attempt-id'], optional: [] },
  evaluate: { required: ['state-root', 'session-id', 'input'], optional: [] },
  shadow: { required: ['input'], optional: [] },
  status: { required: ['state-root', 'session-id'], optional: [] },
  export: { required: ['state-root', 'session-id'], optional: [] },
});

function cliError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function commandNames() {
  return Object.keys(COMMANDS);
}

function parseArgs(argv) {
  if (argv.length === 0 || !(argv[0] in COMMANDS)) throw cliError('CLI_COMMAND_UNKNOWN');
  const command = argv[0];
  const specification = COMMANDS[command];
  const allowed = new Set([...specification.required, ...specification.optional]);
  const flags = {};
  for (let index = 1; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    if (typeof token !== 'string' || !token.startsWith('--')) throw cliError('CLI_FLAG_INVALID');
    const name = token.slice(2);
    if (!allowed.has(name)) throw cliError('CLI_FLAG_UNKNOWN');
    if (name in flags) throw cliError('CLI_FLAG_DUPLICATE');
    if (value === undefined || value.startsWith('--')) throw cliError('CLI_FLAG_VALUE_REQUIRED');
    flags[name] = value;
  }
  for (const name of specification.required) {
    if (!(name in flags)) throw cliError('CLI_FLAG_REQUIRED');
  }
  return { command, flags };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw cliError('CLI_JSON_INVALID');
  }
}

function withStore(stateRoot, action, targetRoots = []) {
  const store = openSessionStore({ stateRoot, targetRoots });
  try {
    return action(store);
  } finally {
    store.close();
  }
}

function init(flags) {
  const compiled = compileDraft(readJson(flags.input));
  if (compiled.gaps.length > 0) throw cliError(compiled.gaps[0].code);
  const session = withStore(
    flags['state-root'],
    (store) => store.create(compiled.session),
    compiled.session.authority_revisions.at(-1).authority.target_roots,
  );
  return {
    ok: true,
    command: 'init',
    session_id: session.session_id,
    status: session.status,
    authorization_hash: session.authorization_hash,
    short_fingerprint: session.authorization_hash.slice(0, 12),
    live_execution: false,
  };
}

function confirm(flags) {
  return withStore(flags['state-root'], (store) => {
    const session = store.read(flags['session-id']);
    const receipt = recordConfirmation({ session, observed: readJson(flags.input) });
    const next = transitionSession(session, { type: 'AUTHORIZATION_CONFIRMED', receipt });
    const committed = store.compareAndCommit({
      sessionId: session.session_id,
      expectedRevision: session.revision,
      eventType: 'AUTHORIZATION_CONFIRMED',
      nextState: next,
      blobs: [],
    });
    return {
      ok: true,
      command: 'confirm',
      session_id: committed.session_id,
      status: committed.status,
      revision: committed.revision,
      live_execution: false,
    };
  });
}

function revise(flags) {
  const request = readJson(flags.input);
  exactFields(request, ['operation', 'controller_facts'], 'revision_request');
  return withStore(flags['state-root'], (store) => {
    const session = store.read(flags['session-id']);
    const evaluation = evaluateRevision({
      session,
      operation: request.operation,
      controllerFacts: request.controller_facts,
    });
    let next = session;
    let eventType = null;
    if (evaluation.decision === 'auto_apply') {
      next = transitionSession(session, { type: 'REVISION_PROPOSED' });
      next.design_revisions.push(evaluation.next_design);
      next = transitionSession(next, { type: 'REVISION_APPLIED' });
      eventType = 'DESIGN_REVISION_AUTO_APPLIED';
    } else if (evaluation.decision === 'reauthorize') {
      next = transitionSession(session, { type: 'REAUTHORIZATION_REQUIRED' });
      eventType = 'REAUTHORIZATION_REQUIRED';
    }
    if (eventType !== null) {
      next = store.compareAndCommit({
        sessionId: session.session_id,
        expectedRevision: session.revision,
        eventType,
        nextState: next,
        blobs: [],
      });
    }
    return {
      ok: true,
      command: 'revise',
      session_id: session.session_id,
      decision: evaluation.decision,
      reason_codes: evaluation.reason_codes,
      status: next.status,
      revision: next.revision,
      reauthorization_required: evaluation.decision === 'reauthorize',
      live_execution: false,
    };
  });
}

function project(flags) {
  return withStore(flags['state-root'], (store) => {
    const session = store.read(flags['session-id']);
    const projection = projectAttempt({
      session,
      designRevision: session.design_revisions.at(-1),
      attemptId: flags['attempt-id'],
    });
    store.putBlob({ kind: 'context-package', bytes: projection.contextPackage.bytes });
    store.putBlob({ kind: 'projection-proof', bytes: projection.projectionProof.bytes });
    return {
      ok: true,
      command: 'project',
      session_id: session.session_id,
      attempt_hash: projection.attemptHash,
      envelope: projection.envelope,
      manifest: projection.manifest,
      live_execution: false,
    };
  });
}

function evaluate(flags) {
  const request = readJson(flags.input);
  exactFields(
    request,
    ['evidence', 'bypasses', 'current_inputs_by_condition', 'now'],
    'evaluation_request',
  );
  return withStore(flags['state-root'], (store) => {
    const session = store.read(flags['session-id']);
    return {
      ok: true,
      command: 'evaluate',
      session_id: session.session_id,
      ...completionLevel({
        session,
        evidence: request.evidence,
        bypasses: request.bypasses,
        currentInputsByCondition: request.current_inputs_by_condition,
        now: request.now,
      }),
      live_execution: false,
    };
  });
}

function shadow(flags) {
  return { ok: true, command: 'shadow', ...classifyShadowReplay(readJson(flags.input)) };
}

function status(flags) {
  return withStore(flags['state-root'], (store) => {
    const session = store.read(flags['session-id']);
    return {
      ok: true,
      command: 'status',
      session_id: session.session_id,
      status: session.status,
      revision: session.revision,
      goal_hash: session.goal_hash,
      authorization_hash: session.authorization_hash,
      design_revision_hash: session.design_revisions.at(-1).design_revision_hash,
      attempts: session.attempts.length,
      evidence: session.evidence.length,
      live_execution: false,
    };
  });
}

function exportSession(flags) {
  return withStore(flags['state-root'], (store) => ({
    ok: true,
    command: 'export',
    export: store.exportSession(flags['session-id']),
    redaction_policy: 'secret references only; secret values are forbidden by schema',
    live_execution: false,
  }));
}

const HANDLERS = Object.freeze({ init, confirm, revise, project, evaluate, shadow, status, export: exportSession });

export function runCli({
  argv = process.argv.slice(2),
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
} = {}) {
  try {
    const { command, flags } = parseArgs(argv);
    stdout(`${JSON.stringify(HANDLERS[command](flags))}\n`);
    return 0;
  } catch (error) {
    stderr(`${JSON.stringify({ ok: false, code: error.code ?? 'CLI_INTERNAL_ERROR' })}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli();
}
