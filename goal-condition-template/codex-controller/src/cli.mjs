import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  initStateDir,
  prepareCodexProbesOnly,
  runCodexClose,
  runCodexFinalize,
  runCodexLaunch,
  runCodexReadback,
  stateDirFor,
} from '../../scripts/launch.mjs';
import {
  CODEX_READ_ONLY_SANDBOX_MODE,
  CODEX_READ_ONLY_SANDBOX_PROFILE,
  CODEX_SANDBOX_MODE,
  CODEX_SANDBOX_PROFILE,
} from '../../scripts/lib/adapters/codex.mjs';
import { canonicalJson, contractHash } from '../../scripts/lib/contract.mjs';
import {
  captureSnapshot,
  compareSnapshot,
  snapshotDigest,
  snapshotDiagnostics,
} from '../../scripts/lib/snapshot.mjs';
import { adoptLegacyContract } from './adoption.mjs';
import { assessCapabilities } from './capabilities.mjs';
import { compileDraft, recordConfirmation, renderAuthorizationPreview } from './compiler.mjs';
import {
  appendAuthorityRevision,
  rejectCurrentCandidateForRevision,
  transitionAttempt,
  transitionSession,
} from './domain.mjs';
import { completionLevel } from './evidence.mjs';
import {
  attemptRuntimePrompt,
  launchControlledAttempt,
  prepareControlledAttempt,
} from './execution.mjs';
import { evaluateRevision } from './policy.mjs';
import { projectAttempt, projectBaselineManifest } from './projector.mjs';
import { reconcileLaunch } from './recovery.mjs';
import { currentControllerReleaseDigest } from './release.mjs';
import {
  assertLiveRollout,
  certifyRolloutCanary,
  readRolloutState,
  writeRolloutMode,
} from './rollout.mjs';
import { classifyShadowReplay } from './shadow.mjs';
import { openSessionStore } from './store.mjs';
import { assertRootIdentities, assertStableStateRoot, exactFields } from './values.mjs';
import { verifyConditions } from './verification.mjs';

const execFile = promisify(execFileCallback);
const CONTROLLER_RELEASE_DIGEST = currentControllerReleaseDigest();

const COMMANDS = Object.freeze({
  init: { required: ['state-root', 'input'], optional: ['capture-baseline'] },
  confirm: { required: ['state-root', 'session-id', 'input'], optional: [] },
  revise: { required: ['state-root', 'session-id', 'input'], optional: [] },
  project: { required: ['state-root', 'session-id', 'attempt-id'], optional: [] },
  preview: { required: ['state-root', 'session-id'], optional: [] },
  evaluate: { required: ['state-root', 'session-id', 'input'], optional: [] },
  shadow: { required: ['input'], optional: [] },
  status: { required: ['state-root', 'session-id'], optional: [] },
  export: { required: ['state-root', 'session-id'], optional: [] },
  capabilities: { required: ['input'], optional: [] },
  adopt: { required: ['state-root', 'input'], optional: [] },
  prepare: { required: ['state-root', 'session-id', 'input'], optional: [] },
  launch: { required: ['state-root', 'session-id', 'run-id', 'runtime-root'], optional: ['deadline-ms'] },
  resume: { required: ['state-root', 'session-id', 'runtime-root', 'input'], optional: [] },
  verify: {
    required: ['state-root', 'session-id', 'attempt-id', 'run-id', 'runtime-root'],
    optional: [],
  },
  finalize: { required: ['state-root', 'session-id', 'run-id', 'runtime-root'], optional: [] },
  reconcile: { required: ['state-root', 'session-id', 'run-id', 'runtime-root'], optional: [] },
  close: { required: ['state-root', 'session-id', 'run-id', 'runtime-root'], optional: [] },
  mode: { required: ['state-root', 'input'], optional: [] },
});

function cliError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertCurrentLiveRollout(stateRoot) {
  return assertLiveRollout(stateRoot, { releaseManifestDigest: CONTROLLER_RELEASE_DIGEST });
}

function assertCurrentAttemptRelease(attempt) {
  if (attempt?.controller_release_digest !== CONTROLLER_RELEASE_DIGEST) {
    throw cliError('CONTROLLER_RELEASE_CHANGED');
  }
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

function revisionControllerProof(session, operation) {
  if (operation?.type !== 'REFRESH_CONTEXT') return {};
  const dependency = session.design_revisions.at(-1).context_dependencies
    .find((item) => item.id === operation.payload?.dependency_id);
  if (dependency === undefined) return {};
  try {
    return {
      context_hash: createHash('sha256').update(readFileSync(dependency.path)).digest('hex'),
    };
  } catch {
    return {};
  }
}

async function withStore(stateRoot, action, targetRoots = []) {
  const store = openSessionStore({ stateRoot, targetRoots });
  try {
    return await action(store);
  } finally {
    store.close();
  }
}

function baselineGitHeads(baseline) {
  return Object.fromEntries((baseline.entries ?? [])
    .filter((entry) => entry.type === 'git')
    .map((entry) => [entry.id, entry.head]));
}

async function captureCurrent({ manifest, baseline }) {
  // The root snapshot is immutable across typed Design revisions, while the projected v1 contract hash
  // intentionally changes per Attempt. Rebind only the snapshot's contract identity in a derived view;
  // entries remain the original controller-owned root baseline bytes.
  // Shared v1 path snapshots compare a recursively captured path entry as one unit. GoalSession v2 grants
  // writes to the complete active target root, so add the root itself only to this derived comparison
  // manifest. This keeps the compatibility workaround Codex-only instead of changing v1/Claude semantics.
  const comparisonManifest = {
    ...structuredClone(manifest),
    allowed_mutations: {
      ...structuredClone(manifest.allowed_mutations),
      files: manifest.allowed_mutations.files.length === 0
        ? []
        : [...new Set([...manifest.allowed_mutations.files, ...manifest.target_roots])],
    },
  };
  const compatibleBaseline = {
    ...structuredClone(baseline),
    contract_hash: contractHash(comparisonManifest),
  };
  const diagnostics = snapshotDiagnostics(comparisonManifest, compatibleBaseline);
  if (diagnostics.length > 0) throw cliError(diagnostics[0].code);
  const current = await captureSnapshot(comparisonManifest, {
    phase: 'verify',
    baselineGitHeads: baselineGitHeads(baseline),
  });
  const comparison = compareSnapshot(comparisonManifest, compatibleBaseline, current, {
    expectedBaselineDigest: snapshotDigest(compatibleBaseline),
  });
  if (!comparison.ok) throw cliError(comparison.diagnostics?.[0]?.code ?? 'WORKSPACE_BOUNDARY_VIOLATION');
  return current;
}

async function init(flags) {
  const input = readJson(flags.input);
  let compiled = compileDraft(input);
  if (compiled.gaps.length > 0) throw cliError(compiled.gaps[0].code);
  let baseline = null;
  if (flags['capture-baseline'] !== undefined) {
    if (flags['capture-baseline'] !== 'true') throw cliError('CLI_BOOLEAN_INVALID');
    const manifest = projectBaselineManifest({ session: compiled.session });
    baseline = await captureSnapshot(manifest, { phase: 'capture' });
    const nextInput = structuredClone(input);
    nextInput.root_baseline = { kind: 'v1-snapshot', digest: snapshotDigest(baseline) };
    compiled = compileDraft(nextInput);
    if (compiled.gaps.length > 0) throw cliError(compiled.gaps[0].code);
  }
  const session = await withStore(
    flags['state-root'],
    (store) => {
      const created = store.create(compiled.session);
      if (baseline !== null) {
        const descriptor = store.putBlob({ kind: 'root-baseline', bytes: canonicalJson(baseline) });
        if (descriptor.hash !== created.root_baseline.digest) throw cliError('ROOT_BASELINE_BLOB_MISMATCH');
      }
      return created;
    },
    compiled.session.authority_revisions.at(-1).authority.target_roots,
  );
  return {
    ok: true,
    command: 'init',
    session_id: session.session_id,
    status: session.status,
    authorization_hash: session.authorization_hash,
    short_fingerprint: session.authorization_hash.slice(0, 12),
    root_baseline_digest: session.root_baseline.digest,
    live_execution: false,
  };
}

async function confirm(flags) {
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

async function revise(flags) {
  const request = readJson(flags.input);
  exactFields(request, ['operation'], 'revision_request');
  return withStore(flags['state-root'], (store) => {
    const session = store.read(flags['session-id']);
    const evaluation = evaluateRevision({
      session,
      operation: request.operation,
      controllerProof: revisionControllerProof(session, request.operation),
    });
    let next = session;
    let eventType = null;
    if (evaluation.decision === 'auto_apply') {
      if (session.status === 'Evaluating') {
        next = rejectCurrentCandidateForRevision(session);
        next = transitionSession(next, { type: 'REVISION_REQUIRED' });
      }
      else if (session.status === 'Ready') next = transitionSession(session, { type: 'REVISION_PROPOSED' });
      else if (session.status !== 'Revising') throw cliError('REVISION_STATE_INVALID');
      next.design_revisions.push(evaluation.next_design);
      next = transitionSession(next, { type: 'REVISION_APPLIED' });
      eventType = 'DESIGN_REVISION_AUTO_APPLIED';
    } else if (evaluation.decision === 'reauthorize') {
      next = request.operation.type === 'EXPAND_AUTHORITY'
        ? appendAuthorityRevision(session, request.operation.payload.authority)
        : session;
      next = transitionSession(next, { type: 'REAUTHORIZATION_REQUIRED' });
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
      authorization_hash: next.authorization_hash,
      reauthorization_required: evaluation.decision === 'reauthorize',
      live_execution: false,
    };
  });
}

async function project(flags) {
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

async function preview(flags) {
  return withStore(flags['state-root'], (store) => {
    const session = store.read(flags['session-id']);
    if (session.status !== 'AwaitingConfirmation' && session.status !== 'AwaitingReauthorization') {
      throw cliError('SESSION_NOT_AWAITING_CONFIRMATION');
    }
    const rendered = renderAuthorizationPreview(session);
    return {
      ok: true,
      command: 'preview',
      session_id: session.session_id,
      authorization_hash: session.authorization_hash,
      ...rendered,
      live_execution: false,
    };
  });
}

async function evaluate(flags) {
  const request = readJson(flags.input);
  exactFields(request, ['evidence', 'bypasses', 'current_inputs_by_condition', 'now'], 'evaluation_request');
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

async function shadow(flags) {
  return { ok: true, command: 'shadow', ...classifyShadowReplay(readJson(flags.input)) };
}

async function status(flags) {
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

async function exportSession(flags) {
  return withStore(flags['state-root'], (store) => ({
    ok: true,
    command: 'export',
    export: store.exportSession(flags['session-id']),
    redaction_policy: 'secret references only; secret values are forbidden by schema',
    live_execution: false,
  }));
}

async function capabilities(flags) {
  const input = readJson(flags.input);
  exactFields(input, ['probes', 'hard_prohibitions'], 'capability_input');
  return { ok: true, command: 'capabilities', ...assessCapabilities({
    probes: input.probes,
    hardProhibitions: input.hard_prohibitions,
  }), live_execution: false };
}

async function adopt(flags) {
  const input = readJson(flags.input);
  exactFields(input, ['contract', 'session_id', 'original_baseline'], 'adoption_input');
  const baseline = input.original_baseline ?? await captureSnapshot(input.contract, { phase: 'capture' });
  const adopted = adoptLegacyContract({
    contract: input.contract,
    sessionId: input.session_id,
    currentStateDigest: snapshotDigest(baseline),
    originalBaseline: input.original_baseline,
  });
  return withStore(flags['state-root'], (store) => {
    const session = store.create(adopted.session);
    const descriptor = store.putBlob({ kind: 'root-baseline', bytes: canonicalJson(baseline) });
    if (descriptor.hash !== session.root_baseline.digest) throw cliError('ROOT_BASELINE_BLOB_MISMATCH');
    store.putBlob({ kind: 'legacy-import', bytes: canonicalJson({
      contract: input.contract,
      provenance: adopted.provenance,
    }) });
    return {
      ok: true,
      command: 'adopt',
      session_id: session.session_id,
      status: session.status,
      provenance: adopted.provenance,
      live_execution: false,
    };
  }, adopted.session.authority_revisions.at(-1).authority.target_roots);
}

function hardProhibitionClaims(session, claims) {
  if (!Array.isArray(claims)) throw cliError('HARD_PROHIBITION_CLAIMS_INVALID');
  const rules = session.authority_revisions.at(-1).authority.hard_prohibitions;
  if (claims.length !== rules.length) throw cliError('HARD_PROHIBITION_CLAIMS_INCOMPLETE');
  return claims.map((claim, index) => {
    exactFields(claim, ['rule', 'capability'], `hard_prohibition_capabilities[${index}]`);
    if (claim.rule !== rules[index]) throw cliError('HARD_PROHIBITION_RULE_MISMATCH');
    if (claim.capability !== claim.rule) throw cliError('HARD_PROHIBITION_CAPABILITY_MISMATCH');
    return { id: `hard-prohibition-${index + 1}`, capability: claim.capability };
  });
}

async function prepareCore({ store, sessionId, input }) {
  exactFields(input, [
    'attempt_id', 'run_id', 'nonce', 'expires_at', 'hard_prohibition_capabilities',
  ], 'prepare_input');
  const session = store.read(sessionId);
  const targetRoots = session.design_revisions.at(-1).active_boundary.target_roots;
  const writable = session.design_revisions.at(-1).active_boundary.actions.includes('write');
  const controllerStateIsolated = assertStableStateRoot({
    stateRoot: store.stateRoot,
    targetRoots,
  });
  const projection = projectAttempt({
    session,
    designRevision: session.design_revisions.at(-1),
    attemptId: input.attempt_id,
  });
  const baseline = JSON.parse(store.getBlob(session.root_baseline.digest).toString('utf8'));
  const current = await captureCurrent({ manifest: projection.manifest, baseline });
  const capabilityReport = assessCapabilities({
    probes: {
      sandbox: writable ? CODEX_SANDBOX_PROFILE : CODEX_READ_ONLY_SANDBOX_PROFILE,
      controller_state_outside_targets: controllerStateIsolated,
      thread_read: true,
      turn_readback: true,
    },
    hardProhibitions: hardProhibitionClaims(session, input.hard_prohibition_capabilities),
  });
  return prepareControlledAttempt({
    store,
    sessionId,
    attemptId: input.attempt_id,
    workspaceDigest: snapshotDigest(current),
    runId: input.run_id,
    expiresAt: input.expires_at,
    nonce: input.nonce,
    capabilityReport,
    controllerReleaseDigest: CONTROLLER_RELEASE_DIGEST,
  });
}

async function prepare(flags) {
  assertCurrentLiveRollout(flags['state-root']);
  return withStore(flags['state-root'], async (store) => {
    const prepared = await prepareCore({
      store,
      sessionId: flags['session-id'],
      input: readJson(flags.input),
    });
    return {
      ok: true,
      command: 'prepare',
      session_id: prepared.session_id,
      attempt_id: prepared.attempt_id,
      run_id: prepared.run_id,
      attempt_hash: prepared.intent.attempt_hash,
      contract_hash: prepared.intent.contract_hash,
      live_execution: false,
    };
  });
}

function runtimeState({ runtimeRoot, sessionId, intent }) {
  const stateDir = stateDirFor({
    stateRoot: runtimeRoot,
    controller: `goal-session-v2-${sessionId}-${intent.attempt_id}`,
    contractHash: intent.contract_hash,
  });
  return {
    stateDir,
    binding: {
      contractHash: intent.contract_hash,
      baselineDigest: intent.workspace_digest,
      runId: intent.run_id,
    },
  };
}

function sandboxModeForProjection(projection) {
  return projection.manifest.allowed_mutations.files.length > 0
    ? CODEX_SANDBOX_MODE
    : CODEX_READ_ONLY_SANDBOX_MODE;
}

function restorePrepared({ store, sessionId, runId }) {
  const stored = store.readLaunchIntent(runId);
  const { status: intentStatus, ...intent } = stored;
  if (!['pending', 'dispatching'].includes(intentStatus)) throw cliError('LAUNCH_INTENT_NOT_PENDING');
  const session = store.read(sessionId);
  if (intent.session_id !== sessionId) throw cliError('LAUNCH_INTENT_SESSION_MISMATCH');
  assertCurrentAttemptRelease(intent);
  const projection = projectAttempt({
    session,
    designRevision: session.design_revisions.at(-1),
    attemptId: intent.attempt_id,
  });
  if (projection.attemptHash !== intent.attempt_hash || contractHash(projection.manifest) !== intent.contract_hash) {
    throw cliError('LAUNCH_INTENT_PROJECTION_MISMATCH');
  }
  return {
    session_id: sessionId,
    attempt_id: intent.attempt_id,
    run_id: runId,
    intent_status: intentStatus,
    intent,
    projection,
    runtime_prompt: attemptRuntimePrompt(projection),
  };
}

async function launchCore({ store, sessionId, runId, runtimeRoot, deadlineMs }) {
  const prepared = restorePrepared({ store, sessionId, runId });
  const runtime = runtimeState({ runtimeRoot, sessionId, intent: prepared.intent });
  await initStateDir(runtime.stateDir);
  await prepareCodexProbesOnly({ stateDir: runtime.stateDir });
  if (prepared.intent_status === 'dispatching') {
    const native = await runCodexReadback({ stateDir: runtime.stateDir });
    const reconciliation = reconcileLaunch({ intent: prepared.intent, receipt: null, native });
    let session = store.read(sessionId);
    if (session.status === 'Dispatching') {
      const next = transitionSession(session, { type: 'RECONCILIATION_REQUIRED' });
      session = store.compareAndCommit({
        sessionId,
        expectedRevision: session.revision,
        eventType: reconciliation.disposition === 'control_plane_bypass'
          ? 'CONTROL_PLANE_BYPASS_DETECTED'
          : 'DISPATCH_RECOVERY_REQUIRED',
        nextState: next,
        blobs: [],
      });
    }
    store.updateLaunchIntentStatus({ runId, status: 'ambiguous' });
    return { ...reconciliation, session };
  }
  return launchControlledAttempt({
    store,
    prepared,
    launch: () => {
      assertRootIdentities(prepared.intent.target_root_identities);
      return runCodexLaunch({
        contract: prepared.projection.manifest,
        stateDir: runtime.stateDir,
        prompt: prepared.runtime_prompt.objective,
        turnText: prepared.runtime_prompt.turn_text,
        binding: runtime.binding,
        sandboxMode: sandboxModeForProjection(prepared.projection),
        deadlineMs,
      });
    },
    readback: () => runCodexReadback({ stateDir: runtime.stateDir }),
    now: new Date().toISOString(),
    controllerReleaseDigest: CONTROLLER_RELEASE_DIGEST,
  });
}

async function launch(flags) {
  assertCurrentLiveRollout(flags['state-root']);
  const deadlineMs = flags['deadline-ms'] === undefined ? undefined : Number(flags['deadline-ms']);
  if (deadlineMs !== undefined && !(Number.isSafeInteger(deadlineMs) && deadlineMs > 0)) {
    throw cliError('DEADLINE_INVALID');
  }
  return withStore(flags['state-root'], async (store) => {
    const result = await launchCore({
      store,
      sessionId: flags['session-id'],
      runId: flags['run-id'],
      runtimeRoot: flags['runtime-root'],
      deadlineMs,
    });
    return {
      ok: result.disposition === 'candidate',
      command: 'launch',
      session_id: flags['session-id'],
      disposition: result.disposition,
      status: result.session.status,
      receipt: result.receipt ?? null,
      reason_codes: result.reason_codes ?? [],
      live_execution: result.receipt !== undefined,
    };
  });
}

async function resume(flags) {
  assertCurrentLiveRollout(flags['state-root']);
  return withStore(flags['state-root'], async (store) => {
    const input = readJson(flags.input);
    exactFields(input, [
      'attempt_id', 'run_id', 'nonce', 'expires_at', 'hard_prohibition_capabilities', 'deadline_ms',
    ], 'resume_input');
    const prepared = await prepareCore({ store, sessionId: flags['session-id'], input: {
      attempt_id: input.attempt_id,
      run_id: input.run_id,
      nonce: input.nonce,
      expires_at: input.expires_at,
      hard_prohibition_capabilities: input.hard_prohibition_capabilities,
    } });
    const result = await launchCore({
      store,
      sessionId: flags['session-id'],
      runId: prepared.run_id,
      runtimeRoot: flags['runtime-root'],
      deadlineMs: input.deadline_ms,
    });
    return {
      ok: result.disposition === 'candidate',
      command: 'resume',
      continuation_kind: 'new-immutable-attempt',
      session_id: flags['session-id'],
      attempt_id: prepared.attempt_id,
      disposition: result.disposition,
      receipt: result.receipt ?? null,
      live_execution: result.receipt !== undefined,
    };
  });
}

async function verify(flags) {
  assertCurrentLiveRollout(flags['state-root']);
  return withStore(flags['state-root'], async (store) => {
    const session = store.read(flags['session-id']);
    if (session.status !== 'Evaluating') throw cliError('SESSION_NOT_EVALUATING');
    const attemptIndex = session.attempts.findIndex((item) => item.attempt_id === flags['attempt-id']);
    if (attemptIndex < 0) throw cliError('ATTEMPT_NOT_FOUND');
    let attempt = session.attempts[attemptIndex];
    assertCurrentAttemptRelease(attempt);
    if (attempt.status !== 'Candidate') throw cliError('ATTEMPT_NOT_CANDIDATE');
    if (attempt.run_id !== flags['run-id']) throw cliError('ATTEMPT_RUN_MISMATCH');
    const stored = store.readLaunchIntent(flags['run-id']);
    const { status: intentStatus, ...intent } = stored;
    if (intentStatus !== 'launched' || intent.session_id !== session.session_id) {
      throw cliError('LAUNCH_INTENT_NOT_ATTRIBUTABLE');
    }
    const runtime = runtimeState({
      runtimeRoot: flags['runtime-root'], sessionId: session.session_id, intent,
    });
    const native = await runCodexReadback({ stateDir: runtime.stateDir });
    const attribution = reconcileLaunch({ intent, receipt: attempt.launch_receipt, native });
    if (!['continue_evaluating', 'control_plane_bypass'].includes(attribution.disposition)) {
      const next = transitionSession(session, { type: 'RECONCILIATION_REQUIRED' });
      const committed = store.compareAndCommit({
        sessionId: session.session_id,
        expectedRevision: session.revision,
        eventType: 'POSTFLIGHT_NATIVE_READBACK_REJECTED',
        nextState: next,
        blobs: [],
      });
      return {
        ok: false,
        command: 'verify',
        session_id: session.session_id,
        attempt_id: attempt.attempt_id,
        completion: { level: 'candidate', reason_codes: attribution.reason_codes },
        status: committed.status,
        live_execution: true,
      };
    }
    const runtimeBypasses = attribution.disposition === 'control_plane_bypass'
      ? [{ type: 'CONTROL_PLANE_BYPASS', reason_codes: attribution.reason_codes }]
      : [];
    attempt.bypasses = [...attempt.bypasses, ...runtimeBypasses];
    const projection = projectBaselineManifest({ session });
    const baseline = JSON.parse(store.getBlob(session.root_baseline.digest).toString('utf8'));
    const current = await captureCurrent({ manifest: projection, baseline });
    const { stdout } = await execFile('codex', ['--version']);
    const result = await verifyConditions({
      session,
      attemptId: attempt.attempt_id,
      runtimeVersionHash: createHash('sha256').update(stdout).digest('hex'),
      projectionHash: attempt.projection_proof_hash,
      snapshotHash: snapshotDigest(current),
      bypasses: attempt.bypasses,
    });
    let next = structuredClone(session);
    if (result.completion.level === 'candidate') {
      attempt = transitionAttempt(attempt, { type: 'POSTFLIGHT_REJECTED' });
      next = transitionSession(next, { type: 'REVISION_REQUIRED' });
    } else {
      attempt = transitionAttempt(attempt, { type: 'POSTFLIGHT_VERIFIED' });
      if (result.completion.level === 'verified') {
        next = transitionSession(next, { type: 'RECONCILIATION_REQUIRED' });
      }
    }
    attempt.completion_level = result.completion.level;
    next.attempts[attemptIndex] = attempt;
    next.evidence.push(...result.evidence);
    const committed = store.compareAndCommit({
      sessionId: next.session_id,
      expectedRevision: session.revision,
      eventType: result.completion.level === 'certified'
        ? 'ATTEMPT_VERIFIED'
        : result.completion.level === 'verified'
          ? 'ATTEMPT_VERIFIED_WITH_BYPASS'
          : 'ATTEMPT_REJECTED',
      nextState: next,
      blobs: result.evidence.map((item) => ({ kind: 'evidence-record', bytes: canonicalJson(item) })),
    });
    return {
      ok: result.completion.level === 'certified',
      command: 'verify',
      session_id: session.session_id,
      attempt_id: attempt.attempt_id,
      completion: result.completion,
      status: committed.status,
      live_execution: false,
    };
  });
}

async function finalize(flags) {
  assertCurrentLiveRollout(flags['state-root']);
  return withStore(flags['state-root'], async (store) => {
    const session = store.read(flags['session-id']);
    const stored = store.readLaunchIntent(flags['run-id']);
    const { status: ignored, ...intent } = stored;
    const attemptIndex = session.attempts.findIndex((item) => item.run_id === intent.run_id);
    if (attemptIndex < 0) throw cliError('ATTEMPT_NOT_FOUND');
    const attempt = session.attempts[attemptIndex];
    assertCurrentAttemptRelease(attempt);
    if (attempt.status !== 'Verified' || attempt.completion_level !== 'certified') {
      throw cliError('ATTEMPT_NOT_CERTIFIED');
    }
    const runtime = runtimeState({
      runtimeRoot: flags['runtime-root'], sessionId: session.session_id, intent,
    });
    const result = await runCodexFinalize({
      stateDir: runtime.stateDir,
      binding: runtime.binding,
      expectedTurnIds: attempt.launch_receipt.authorized_turn_ids,
    });
    if (result.attribution.ok !== true) {
      let next = structuredClone(session);
      let eventType = 'FINALIZE_NATIVE_ATTRIBUTION_REJECTED';
      if (result.turnFence?.reason_codes?.includes('UNRECEIPTED_NATIVE_TURN')) {
        const nextAttempt = next.attempts[attemptIndex];
        if (!nextAttempt.bypasses.some((item) => item.type === 'CONTROL_PLANE_BYPASS')) {
          nextAttempt.bypasses.push({
            type: 'CONTROL_PLANE_BYPASS',
            reason_codes: result.turnFence.reason_codes,
          });
        }
        nextAttempt.completion_level = 'verified';
        eventType = 'CONTROL_PLANE_BYPASS_DETECTED';
      }
      next = transitionSession(next, { type: 'RECONCILIATION_REQUIRED' });
      const committed = store.compareAndCommit({
        sessionId: session.session_id,
        expectedRevision: session.revision,
        eventType,
        nextState: next,
        blobs: [],
      });
      return {
        ok: false, command: 'finalize', session_id: session.session_id,
        attribution: result.attribution, status: committed.status, live_execution: true,
      };
    }
    const next = transitionSession(session, {
      type: 'CERTIFIED',
      certification: { level: 'certified', controller_owned: true },
    });
    const committed = store.compareAndCommit({
      sessionId: session.session_id,
      expectedRevision: session.revision,
      eventType: 'GOAL_SESSION_CERTIFIED',
      nextState: next,
      blobs: [
        { kind: 'finalization-receipt', bytes: readFileSync(result.receiptPath) },
        { kind: 'runtime-readback', bytes: readFileSync(result.readbackPath) },
      ],
    });
    const lease = store.readRootLease(
      session.design_revisions.at(-1).active_boundary.target_roots[0],
      { runId: intent.run_id },
    );
    store.releaseRootLeases({ runId: intent.run_id, ownerToken: lease.owner_token });
    store.updateLaunchIntentStatus({ runId: intent.run_id, status: 'closed' });
    return {
      ok: true,
      command: 'finalize',
      session_id: session.session_id,
      status: committed.status,
      attribution: result.attribution,
      live_execution: true,
    };
  });
}

async function reconcile(flags) {
  return withStore(flags['state-root'], async (store) => {
    const session = store.read(flags['session-id']);
    const stored = store.readLaunchIntent(flags['run-id']);
    const { status: ignored, ...intent } = stored;
    const runtime = runtimeState({
      runtimeRoot: flags['runtime-root'], sessionId: session.session_id, intent,
    });
    const native = await runCodexReadback({ stateDir: runtime.stateDir });
    const attempt = session.attempts.find((item) => item.run_id === intent.run_id);
    const result = reconcileLaunch({ intent, receipt: attempt?.launch_receipt ?? null, native });
    if (result.disposition === 'continue_evaluating' && session.status === 'ReconciliationRequired') {
      const next = transitionSession(session, {
        type: 'RECONCILED_TO_EVALUATING', reconciliation: { controller_owned: true },
      });
      const committed = store.compareAndCommit({
        sessionId: session.session_id,
        expectedRevision: session.revision,
        eventType: 'LAUNCH_RECONCILED',
        nextState: next,
        blobs: [],
      });
      store.updateLaunchIntentStatus({ runId: intent.run_id, status: 'reconciled' });
      return { ok: true, command: 'reconcile', ...result, status: committed.status, live_execution: false };
    }
    if (result.disposition === 'not_started' && session.status === 'ReconciliationRequired') {
      const next = transitionSession(session, {
        type: 'RECONCILED', reconciliation: { controller_owned: true },
      });
      const committed = store.compareAndCommit({
        sessionId: session.session_id,
        expectedRevision: session.revision,
        eventType: 'DISPATCH_CONFIRMED_NOT_STARTED',
        nextState: next,
        blobs: [],
      });
      const root = session.design_revisions.at(-1).active_boundary.target_roots[0];
      const lease = store.readRootLease(root, { runId: intent.run_id });
      store.releaseRootLeases({ runId: intent.run_id, ownerToken: lease.owner_token });
      store.updateLaunchIntentStatus({ runId: intent.run_id, status: 'closed' });
      return {
        ok: true,
        command: 'reconcile',
        ...result,
        relaunch_allowed: false,
        reason_codes: [...result.reason_codes, 'NEW_ATTEMPT_REQUIRED'],
        status: committed.status,
        live_execution: false,
      };
    }
    if (result.disposition === 'control_plane_bypass' && attempt !== undefined) {
      const next = structuredClone(session);
      const index = next.attempts.findIndex((item) => item.attempt_id === attempt.attempt_id);
      if (!next.attempts[index].bypasses.some((item) => item.type === 'CONTROL_PLANE_BYPASS')) {
        next.attempts[index].bypasses.push({
          type: 'CONTROL_PLANE_BYPASS', reason_codes: result.reason_codes,
        });
      }
      const committed = store.compareAndCommit({
        sessionId: session.session_id,
        expectedRevision: session.revision,
        eventType: 'CONTROL_PLANE_BYPASS_DETECTED',
        nextState: next,
        blobs: [],
      });
      return { ok: false, command: 'reconcile', ...result, status: committed.status, live_execution: false };
    }
    return { ok: false, command: 'reconcile', ...result, status: session.status, live_execution: false };
  });
}

async function close(flags) {
  return withStore(flags['state-root'], async (store) => {
    let session = store.read(flags['session-id']);
    const stored = store.readLaunchIntent(flags['run-id']);
    const { status: ignored, ...intent } = stored;
    const runtime = runtimeState({
      runtimeRoot: flags['runtime-root'], sessionId: session.session_id, intent,
    });
    const result = await runCodexClose({ stateDir: runtime.stateDir });
    if (result.cleanupComplete !== true) {
      if (!['Complete', 'Superseded', 'ReconciliationRequired'].includes(session.status)) {
        session = store.compareAndCommit({
          sessionId: session.session_id,
          expectedRevision: session.revision,
          eventType: 'CONTROLLER_CLEANUP_FAILED',
          nextState: transitionSession(session, { type: 'RECONCILIATION_REQUIRED' }),
          blobs: [],
        });
      }
      if (!['cleanup_failed', 'closed'].includes(stored.status)) {
        store.updateLaunchIntentStatus({ runId: intent.run_id, status: 'cleanup_failed' });
      }
      return {
        ok: false,
        command: 'close',
        session_id: session.session_id,
        status: session.status,
        root_lease_released: false,
        result,
        live_execution: true,
      };
    }
    if (['Dispatching', 'Running', 'ReconciliationRequired', 'Blocked'].includes(session.status)) {
      const next = structuredClone(session);
      if (session.status === 'Running') {
        const attemptIndex = next.attempts.findLastIndex((attempt) => attempt.status === 'Launched');
        if (attemptIndex >= 0) {
          next.attempts[attemptIndex] = transitionAttempt(
            next.attempts[attemptIndex], { type: 'RUNTIME_TERMINATED' },
          );
          next.attempts[attemptIndex].completion_level = 'candidate';
        }
      }
      session = store.compareAndCommit({
        sessionId: session.session_id,
        expectedRevision: session.revision,
        eventType: 'CONTROLLER_CLOSED',
        nextState: transitionSession(next, {
          type: 'CONTROLLER_CLOSED', cleanup: { controller_owned: true },
        }),
        blobs: [],
      });
    }
    const root = session.design_revisions.at(-1).active_boundary.target_roots[0];
    let rootLeaseReleased = false;
    try {
      const lease = store.readRootLease(root, { runId: intent.run_id });
      store.releaseRootLeases({ runId: intent.run_id, ownerToken: lease.owner_token });
      rootLeaseReleased = true;
    } catch (error) {
      if (error.code !== 'TARGET_ROOT_LEASE_NOT_FOUND') throw error;
    }
    if (stored.status !== 'closed') store.updateLaunchIntentStatus({ runId: intent.run_id, status: 'closed' });
    return {
      ok: true,
      command: 'close',
      session_id: session.session_id,
      status: session.status,
      root_lease_released: rootLeaseReleased,
      result,
      live_execution: true,
    };
  });
}

async function mode(flags) {
  const input = readJson(flags.input);
  exactFields(input, ['action', 'next', 'changed_at', 'canary_session_id'], 'mode_input');
  assertStableStateRoot({ stateRoot: flags['state-root'] });
  mkdirSync(flags['state-root'], { recursive: true, mode: 0o700 });
  const path = join(flags['state-root'], 'rollout.json');
  const currentState = readRolloutState(path);
  const current = currentState.mode;
  if (input.action === 'get') {
    if (input.next !== null || input.changed_at !== null || input.canary_session_id !== null) {
      throw cliError('MODE_GET_FIELDS_INVALID');
    }
    return {
      ok: true,
      command: 'mode',
      mode: current,
      release_manifest_digest: CONTROLLER_RELEASE_DIGEST,
      canary_session_id: currentState.canary_receipt?.session_id ?? null,
      live_execution: false,
    };
  }
  if (input.action !== 'set' || typeof input.next !== 'string' || typeof input.changed_at !== 'string') {
    throw cliError('MODE_ACTION_INVALID');
  }
  let canaryReceipt = null;
  if (current === 'opt-in' && input.next === 'default') {
    if (typeof input.canary_session_id !== 'string' || input.canary_session_id.length === 0) {
      throw cliError('ROLLOUT_CANARY_REQUIRED');
    }
    canaryReceipt = await withStore(flags['state-root'], (store) =>
      certifyRolloutCanary(store.exportSession(input.canary_session_id), {
        releaseManifestDigest: CONTROLLER_RELEASE_DIGEST,
      }));
  } else if (input.canary_session_id !== null) {
    throw cliError('ROLLOUT_CANARY_UNEXPECTED');
  }
  const next = writeRolloutMode({
    path,
    current,
    next: input.next,
    changedAt: input.changed_at,
    canaryReceipt,
    priorCanaryReceipt: currentState.canary_receipt,
  });
  return {
    ok: true,
    command: 'mode',
    previous: current,
    mode: next,
    release_manifest_digest: CONTROLLER_RELEASE_DIGEST,
    canary_session_id: canaryReceipt?.session_id ?? currentState.canary_receipt?.session_id ?? null,
    live_execution: false,
  };
}

const HANDLERS = Object.freeze({
  init, confirm, revise, project, preview, evaluate, shadow, status, export: exportSession,
  capabilities, adopt, prepare, launch, resume, verify, finalize, reconcile, close, mode,
});

export async function runCli({
  argv = process.argv.slice(2),
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
} = {}) {
  try {
    const { command, flags } = parseArgs(argv);
    stdout(`${JSON.stringify(await HANDLERS[command](flags))}\n`);
    return 0;
  } catch (error) {
    stderr(`${JSON.stringify({ ok: false, code: error.code ?? 'CLI_INTERNAL_ERROR' })}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli();
}
